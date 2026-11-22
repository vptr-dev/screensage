// Moves the mouse and types on Windows, for "Fill in". A small PowerShell
// process is started on first use and stays around; it takes one command per
// line and answers "ok" (or "err ...") for each.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
$refs = @(
  [System.Windows.Automation.AutomationElement].Assembly.Location,
  [System.Windows.Automation.ControlType].Assembly.Location,
  [System.Windows.Rect].Assembly.Location
)
Add-Type -ReferencedAssemblies $refs -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows.Automation;
public static class SageInput {
  // ----- finding the controls under the frame -----
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);

  // The top window under a point, skipping our own windows and see-through overlays.
  static IntPtr WindowAt(int x, int y, uint skipPid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      int cloaked;
      if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == skipPid) return true;
      if ((GetWindowLong(h, -20) & 0x20) != 0) return true;
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      if (x < r.Left || x >= r.Right || y < r.Top || y >= r.Bottom) return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }

  public static string Json(string s) {
    if (s == null) return "\"\"";
    if (s.Length > 120) s = s.Substring(0, 120);
    var b = new StringBuilder("\"");
    foreach (char c in s) {
      if (c == '"' || c == '\\') { b.Append('\\'); b.Append(c); }
      else if (c < 32) b.Append(' ');
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }

  static string Collect(int x, int y, int w, int h, uint skipPid) {
    IntPtr hwnd = WindowAt(x + w / 2, y + h / 2, skipPid);
    if (hwnd == IntPtr.Zero) return "{\"error\":\"no window\"}";
    AutomationElement root = AutomationElement.FromHandle(hwnd);
    ControlType[] types = {
      ControlType.Edit, ControlType.RadioButton, ControlType.CheckBox, ControlType.ComboBox,
      ControlType.ListItem, ControlType.Button, ControlType.Hyperlink, ControlType.Text,
      ControlType.Slider, ControlType.Spinner, ControlType.TreeItem, ControlType.DataItem,
      ControlType.MenuItem, ControlType.TabItem, ControlType.SplitButton
    };
    var conditions = new List<Condition>();
    foreach (var t in types) conditions.Add(new PropertyCondition(AutomationElement.ControlTypeProperty, t));
    var condition = new AndCondition(new OrCondition(conditions.ToArray()),
      new PropertyCondition(AutomationElement.IsOffscreenProperty, false));
    var all = root.FindAll(TreeScope.Descendants, condition);
    var frame = new System.Windows.Rect(x, y, w, h);
    var b = new StringBuilder("[");
    int n = 0;
    foreach (AutomationElement e in all) {
      if (n >= 120) break;
      try {
        var info = e.Current;
        var box = info.BoundingRectangle;
        if (box.IsEmpty || box.Width < 3 || box.Height < 3) continue;
        double cx = box.X + box.Width / 2, cy = box.Y + box.Height / 2;
        if (!frame.Contains(cx, cy)) continue;
        string type = info.ControlType.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant();
        string name = (info.Name ?? "").Trim();
        if (type == "text" && name.Length == 0) continue;
        string value = "", state = "";
        object p;
        if ((type == "edit" || type == "combobox" || type == "spinner") && e.TryGetCurrentPattern(ValuePattern.Pattern, out p))
          value = ((ValuePattern)p).Current.Value;
        if (e.TryGetCurrentPattern(TogglePattern.Pattern, out p))
          state = ((TogglePattern)p).Current.ToggleState == ToggleState.On ? "checked" : "not checked";
        else if ((type == "radiobutton" || type == "listitem" || type == "treeitem" || type == "dataitem") && e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p))
          state = ((SelectionItemPattern)p).Current.IsSelected ? "selected" : "not selected";
        if (n > 0) b.Append(',');
        b.Append("{\"type\":").Append(Json(type)).Append(",\"name\":").Append(Json(name))
          .Append(",\"value\":").Append(Json(value)).Append(",\"state\":").Append(Json(state))
          .Append(",\"x\":").Append((int)cx).Append(",\"y\":").Append((int)cy).Append('}');
        n++;
      } catch { }
    }
    return b.Append(']').ToString();
  }

  static string Simplify(string s) {
    var b = new StringBuilder();
    foreach (char c in (s ?? "").ToLowerInvariant()) if (char.IsLetterOrDigit(c)) b.Append(c);
    return b.ToString();
  }

  // Controls whose name contains the wanted text, in the window under (px, py), centred inside the area.
  static string Search(int px, int py, int x, int y, int w, int h, uint skipPid, string wanted) {
    IntPtr hwnd = WindowAt(px, py, skipPid);
    if (hwnd == IntPtr.Zero) return "[]";
    AutomationElement root = AutomationElement.FromHandle(hwnd);
    string want = Simplify(wanted);
    if (want.Length == 0) return "[]";
    var condition = new PropertyCondition(AutomationElement.IsOffscreenProperty, false);
    var all = root.FindAll(TreeScope.Descendants, condition);
    var area = new System.Windows.Rect(x, y, w, h);
    var b = new StringBuilder("[");
    int n = 0;
    foreach (AutomationElement e in all) {
      if (n >= 60) break;
      try {
        var info = e.Current;
        string name = (info.Name ?? "").Trim();
        if (name.Length == 0 || name.Length > 200 || !Simplify(name).Contains(want)) continue;
        var box = info.BoundingRectangle;
        if (box.IsEmpty || box.Width < 3 || box.Height < 3) continue;
        double cx = box.X + box.Width / 2, cy = box.Y + box.Height / 2;
        if (!area.Contains(cx, cy)) continue;
        string type = info.ControlType.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant();
        if (n > 0) b.Append(',');
        b.Append("{\"type\":").Append(Json(type)).Append(",\"name\":").Append(Json(name))
          .Append(",\"x\":").Append((int)cx).Append(",\"y\":").Append((int)cy)
          .Append(",\"w\":").Append((int)box.Width).Append(",\"h\":").Append((int)box.Height).Append('}');
        n++;
      } catch { }
    }
    return b.Append(']').ToString();
  }

  // Every named control under a point (the smallest is what was pointed at).
  static string Under(int x, int y, uint skipPid) {
    IntPtr hwnd = WindowAt(x, y, skipPid);
    if (hwnd == IntPtr.Zero) return "[]";
    AutomationElement root = AutomationElement.FromHandle(hwnd);
    var all = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.IsOffscreenProperty, false));
    var point = new System.Windows.Point(x, y);
    var b = new StringBuilder("[");
    int n = 0;
    foreach (AutomationElement e in all) {
      if (n >= 40) break;
      try {
        var info = e.Current;
        var box = info.BoundingRectangle;
        if (box.IsEmpty || !box.Contains(point)) continue;
        string name = (info.Name ?? "").Trim();
        if (name.Length == 0 || name.Length > 120) continue;
        string type = info.ControlType.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant();
        if (n > 0) b.Append(',');
        b.Append("{\"type\":").Append(Json(type)).Append(",\"name\":").Append(Json(name))
          .Append(",\"x\":").Append((int)(box.X + box.Width / 2)).Append(",\"y\":").Append((int)(box.Y + box.Height / 2))
          .Append(",\"w\":").Append((int)box.Width).Append(",\"h\":").Append((int)box.Height).Append('}');
        n++;
      } catch { }
    }
    return b.Append(']').ToString();
  }

  delegate string Job();
  static string Timed(Job job) {
    string result = "[]";
    var worker = new Thread(delegate () {
      try { result = job(); }
      catch (Exception e) { result = "{\"error\":" + Json(e.GetType().Name + ": " + e.Message) + "}"; }
    });
    worker.IsBackground = true;
    worker.Start();
    return worker.Join(6000) ? result : "[]";
  }

  public static string Elements(int x, int y, int w, int h, uint skipPid) {
    return Timed(delegate () { return Collect(x, y, w, h, skipPid); });
  }

  public static string At(int x, int y, uint skipPid) {
    return Timed(delegate () { return Under(x, y, skipPid); });
  }

  // Browsers build their page's controls for Windows only once something walks through them all.
  static string Walk(int x, int y, uint skipPid) {
    IntPtr hwnd = WindowAt(x, y, skipPid);
    if (hwnd == IntPtr.Zero) return "0";
    var all = AutomationElement.FromHandle(hwnd).FindAll(TreeScope.Descendants, Condition.TrueCondition);
    int n = 0;
    foreach (AutomationElement e in all) {
      if (n++ >= 400) break;
      try { var info = e.Current; string name = info.Name; var box = info.BoundingRectangle; } catch { }
    }
    return n.ToString();
  }

  public static string Wake(int x, int y, uint skipPid) {
    return Timed(delegate () { return Walk(x, y, skipPid); });
  }

  public static string Find(int px, int py, int x, int y, int w, int h, uint skipPid, string wanted) {
    return Timed(delegate () { return Search(px, py, x, y, w, h, skipPid, wanted); });
  }

  // ----- mouse and keyboard -----
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  public static void Init() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch {}
    SetProcessDPIAware();
  }
  static void Mouse(uint flags, uint data) {
    INPUT i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data;
    SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT)));
  }
  static void Vk(ushort vk, bool up) { Vk(vk, up, false); }
  static void Vk(ushort vk, bool up, bool extended) {
    INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk;
    i.u.ki.dwFlags = (up ? 2u : 0u) | (extended ? 1u : 0u);
    SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Move(int x, int y) { SetCursorPos(x, y); }
  public static void Down() { Mouse(0x0002, 0); }
  public static void Up() { Mouse(0x0004, 0); }
  public static void RightDown() { Mouse(0x0008, 0); }
  public static void RightUp() { Mouse(0x0010, 0); }

  static ushort VkOf(string k, out bool extended) {
    extended = false;
    if (k.Length == 1) {
      char c = char.ToUpperInvariant(k[0]);
      if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return c;
      switch (c) {
        case '\x60': return 0xC0; case '-': return 0xBD; case '=': return 0xBB; case '[': return 0xDB;
        case ']': return 0xDD; case ';': return 0xBA; case '\'': return 0xDE; case ',': return 0xBC;
        case '.': return 0xBE; case '/': return 0xBF; case '\\': return 0xDC;
      }
      return 0;
    }
    int f;
    if (k[0] == 'f' && int.TryParse(k.Substring(1), out f) && f >= 1 && f <= 24) return (ushort)(0x6F + f);
    switch (k) {
      case "enter": return 0x0D; case "tab": return 0x09; case "escape": case "esc": return 0x1B;
      case "space": return 0x20; case "backspace": return 0x08;
    }
    extended = true;
    switch (k) {
      case "delete": return 0x2E; case "insert": return 0x2D; case "home": return 0x24; case "end": return 0x23;
      case "pageup": return 0x21; case "pagedown": return 0x22; case "up": return 0x26; case "down": return 0x28;
      case "left": return 0x25; case "right": return 0x27;
    }
    return 0;
  }

  // "Control+Shift+K": hold the modifiers, tap the key, let go in reverse.
  public static void Combo(string spec) {
    var mods = new List<ushort>();
    ushort key = 0; bool extended = false;
    foreach (string raw in spec.Split('+')) {
      string k = raw.Trim().ToLowerInvariant();
      if (k == "control" || k == "ctrl") mods.Add(0x11);
      else if (k == "alt") mods.Add(0x12);
      else if (k == "shift") mods.Add(0x10);
      else if (k == "super" || k == "win") mods.Add(0x5B);
      else if (k.Length > 0) key = VkOf(k, out extended);
    }
    foreach (ushort m in mods) Vk(m, false, m == 0x5B);
    if (key != 0) { Vk(key, false, extended); Thread.Sleep(20); Vk(key, true, extended); }
    for (int i = mods.Count - 1; i >= 0; i--) Vk(mods[i], true, mods[i] == 0x5B);
  }
  public static void Wheel(int clicks) { Mouse(0x0800, unchecked((uint)(clicks * 120))); }
  public static void Text(string s) {
    foreach (char c in s) {
      INPUT d = new INPUT(); d.type = 1; d.u.ki.wScan = c; d.u.ki.dwFlags = 4;
      INPUT u = new INPUT(); u.type = 1; u.u.ki.wScan = c; u.u.ki.dwFlags = 6;
      SendInput(2, new INPUT[] { d, u }, Marshal.SizeOf(typeof(INPUT)));
      System.Threading.Thread.Sleep(12);
    }
  }
  public static void Key(string name) {
    if (name == "selectall") { Vk(0x11, false); Vk(0x41, false); Vk(0x41, true); Vk(0x11, true); return; }
    ushort vk = name == "enter" ? (ushort)0x0D : name == "tab" ? (ushort)0x09 : name == "backspace" ? (ushort)0x08
      : name == "space" ? (ushort)0x20 : name == "escape" ? (ushort)0x1B : name == "down" ? (ushort)0x28 : name == "up" ? (ushort)0x26 : (ushort)0;
    if (vk == 0) return;
    Vk(vk, false); Vk(vk, true);
  }
}
'@
[SageInput]::Init()

# Reading text from a picture with Windows' own text recognition, for apps
# that don't describe their buttons. Loaded the first time it is needed.
$script:ocrReady = $false
function Initialize-Ocr {
  if ($script:ocrReady) { return }
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation?1'
  } | Select-Object -First 1
  $script:ocrReady = $true
}
function Wait-Op($operation, [Type]$type) {
  $task = $script:asTask.MakeGenericMethod($type).Invoke($null, @($operation))
  $null = $task.Wait(-1)
  $task.Result
}
function Read-Words([string]$path) {
  Initialize-Ocr
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) { return '[]' }
  $file = Wait-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $stream = Wait-Op ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Wait-Op ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Wait-Op ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Wait-Op ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  } finally {
    $stream.Dispose()
  }
  $out = New-Object System.Text.StringBuilder
  [void]$out.Append('[')
  $first = $true
  $lineNo = 0
  foreach ($line in $result.Lines) {
    foreach ($word in $line.Words) {
      $r = $word.BoundingRect
      if (-not $first) { [void]$out.Append(',') }
      $first = $false
      [void]$out.Append('{"line":' + $lineNo + ',"t":' + [SageInput]::Json($word.Text) + ',"x":' + [int]$r.X + ',"y":' + [int]$r.Y + ',"w":' + [int]$r.Width + ',"h":' + [int]$r.Height + '}')
    }
    $lineNo++
  }
  [void]$out.Append(']')
  $out.ToString()
}

[Console]::Out.WriteLine('ready')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $p = $line.Split(' ')
    if ($p[0] -eq 'elements') {
      [Console]::Out.WriteLine('ok ' + [SageInput]::Elements([int]$p[1], [int]$p[2], [int]$p[3], [int]$p[4], [uint32]$p[5]))
      continue
    }
    if ($p[0] -eq 'find') {
      $wanted = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[8]))
      [Console]::Out.WriteLine('ok ' + [SageInput]::Find([int]$p[1], [int]$p[2], [int]$p[3], [int]$p[4], [int]$p[5], [int]$p[6], [uint32]$p[7], $wanted))
      continue
    }
    if ($p[0] -eq 'at') {
      [Console]::Out.WriteLine('ok ' + [SageInput]::At([int]$p[1], [int]$p[2], [uint32]$p[3]))
      continue
    }
    if ($p[0] -eq 'wake') {
      [Console]::Out.WriteLine('ok ' + [SageInput]::Wake([int]$p[1], [int]$p[2], [uint32]$p[3]))
      continue
    }
    if ($p[0] -eq 'ocr') {
      $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1]))
      [Console]::Out.WriteLine('ok ' + (Read-Words $path))
      continue
    }
    switch ($p[0]) {
      'move' { [SageInput]::Move([int]$p[1], [int]$p[2]) }
      'down' { [SageInput]::Down() }
      'up' { [SageInput]::Up() }
      'rdown' { [SageInput]::RightDown() }
      'rup' { [SageInput]::RightUp() }
      'wheel' { [SageInput]::Wheel([int]$p[1]) }
      'text' { [SageInput]::Text([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1]))) }
      'key' { [SageInput]::Key($p[1]) }
      'combo' { [SageInput]::Combo($p[1]) }
    }
    [Console]::Out.WriteLine('ok')
  } catch {
    [Console]::Out.WriteLine('err ' + $_.Exception.Message)
  }
}
`;

let child = null;
let ready = null;
let buffer = '';
const waiting = [];

function start() {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    // Too long for a command line, so it runs from a file named after its contents.
    const hash = crypto.createHash('sha256').update(SCRIPT).digest('hex').slice(0, 12);
    const file = path.join(os.tmpdir(), `screensage-input-${hash}.ps1`);
    try {
      if (!fs.existsSync(file)) fs.writeFileSync(file, `﻿${SCRIPT}`, 'utf8');
    } catch (error) {
      reject(error);
      ready = null;
      return;
    }
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const fail = (error) => {
      child = null;
      ready = null;
      reject(error);
      while (waiting.length) waiting.shift().reject(error);
    };
    child.on('error', fail);
    child.on('exit', () => fail(new Error("Couldn't control the mouse.")));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      buffer += data;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line === 'ready') resolve();
        else if (waiting.length) {
          const job = waiting.shift();
          if (line.startsWith('err')) job.reject(new Error(line.slice(4)));
          else job.resolve(line.slice(3));
        }
      }
    });
  });
  return ready;
}

async function run(command) {
  await start();
  return new Promise((resolve, reject) => {
    waiting.push({ resolve, reject });
    child.stdin.write(`${command}\n`);
  });
}

const round = (n) => Math.round(Number(n) || 0);
const b64 = (value) => Buffer.from(String(value), 'utf8').toString('base64');

function list(raw, what) {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (process.env.SAGE_DEBUG) console.error(`${what}:`, parsed.error);
  } catch {
    if (process.env.SAGE_DEBUG) console.error(`${what} raw:`, String(raw).slice(0, 300));
  }
  return [];
}

const rectArgs = (r) => `${round(r.x)} ${round(r.y)} ${round(r.width)} ${round(r.height)}`;

module.exports = {
  warmUp: () => start().catch(() => {}),
  /** The controls inside a rectangle of real screen pixels, with their centres. */
  async elements(rect, skipPid) {
    return list(await run(`elements ${rectArgs(rect)} ${round(skipPid)}`), 'elements');
  },
  /** Controls whose name contains text, in the window under a point, centred inside an area (real pixels). */
  async find(point, area, skipPid, text) {
    return list(await run(`find ${round(point.x)} ${round(point.y)} ${rectArgs(area)} ${round(skipPid)} ${b64(text)}`), 'find');
  },
  /** The named controls under a point (real pixels), any size. */
  async under(point, skipPid) {
    return list(await run(`at ${round(point.x)} ${round(point.y)} ${round(skipPid)}`), 'at');
  },
  /** Walk every control in the window under a point (real pixels), so a browser builds its page's controls. */
  async wake(point, skipPid) {
    return Number(await run(`wake ${round(point.x)} ${round(point.y)} ${round(skipPid)}`)) || 0;
  },
  /** Words Windows can read in a picture file: { line, t, x, y, w, h } in the picture's pixels. */
  async readWords(file) {
    return list(await run(`ocr ${b64(file)}`), 'ocr');
  },
  move: (x, y) => run(`move ${round(x)} ${round(y)}`),
  down: () => run('down'),
  up: () => run('up'),
  rightDown: () => run('rdown'),
  rightUp: () => run('rup'),
  combo: (spec) => run(`combo ${String(spec).replace(/[^\w+`\-=[\];',./\\]/g, '')}`),
  wheel: (clicks) => run(`wheel ${round(clicks)}`),
  type: (value) => run(`text ${b64(value)}`),
  key: (name) => run(`key ${String(name).replace(/[^a-z]/g, '')}`),
  stop() {
    if (child) child.kill();
  },
};
