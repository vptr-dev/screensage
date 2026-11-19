// Moves the mouse and types on Windows, for "Fill in". A small PowerShell
// process is started on first use and stays around; it takes one command per
// line and answers "ok" (or "err ...") for each.
const { spawn } = require('child_process');

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

  static string Json(string s) {
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
      ControlType.Slider, ControlType.Spinner, ControlType.TreeItem, ControlType.DataItem
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

  public static string Elements(int x, int y, int w, int h, uint skipPid) {
    string result = "[]";
    var worker = new Thread(delegate () {
      try { result = Collect(x, y, w, h, skipPid); }
      catch (Exception e) { result = "{\"error\":" + Json(e.GetType().Name + ": " + e.Message) + "}"; }
    });
    worker.IsBackground = true;
    worker.Start();
    return worker.Join(6000) ? result : "[]";
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
  static void Vk(ushort vk, bool up) {
    INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.dwFlags = up ? 2u : 0u;
    SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Move(int x, int y) { SetCursorPos(x, y); }
  public static void Down() { Mouse(0x0002, 0); }
  public static void Up() { Mouse(0x0004, 0); }
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
[Console]::Out.WriteLine('ready')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $p = $line.Split(' ')
    if ($p[0] -eq 'elements') {
      [Console]::Out.WriteLine('ok ' + [SageInput]::Elements([int]$p[1], [int]$p[2], [int]$p[3], [int]$p[4], [uint32]$p[5]))
      continue
    }
    switch ($p[0]) {
      'move' { [SageInput]::Move([int]$p[1], [int]$p[2]) }
      'down' { [SageInput]::Down() }
      'up' { [SageInput]::Up() }
      'wheel' { [SageInput]::Wheel([int]$p[1]) }
      'text' { [SageInput]::Text([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1]))) }
      'key' { [SageInput]::Key($p[1]) }
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
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
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

module.exports = {
  warmUp: () => start().catch(() => {}),
  /** The controls inside a rectangle of real screen pixels, with their centres. */
  async elements(rect, skipPid) {
    const raw = await run(`elements ${round(rect.x)} ${round(rect.y)} ${round(rect.width)} ${round(rect.height)} ${round(skipPid)}`);
    try {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return list;
      if (process.env.SAGE_DEBUG) console.error('elements:', list.error);
    } catch {
      if (process.env.SAGE_DEBUG) console.error('elements raw:', raw.slice(0, 300));
    }
    return [];
  },
  move: (x, y) => run(`move ${round(x)} ${round(y)}`),
  down: () => run('down'),
  up: () => run('up'),
  wheel: (clicks) => run(`wheel ${round(clicks)}`),
  type: (value) => run(`text ${Buffer.from(String(value), 'utf8').toString('base64')}`),
  key: (name) => run(`key ${String(name).replace(/[^a-z]/g, '')}`),
  stop() {
    if (child) child.kill();
  },
};
