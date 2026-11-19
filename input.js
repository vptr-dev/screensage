// Moves the mouse and types on Windows, for "Fill in". A small PowerShell
// process is started on first use and stays around; it takes one command per
// line and answers "ok" (or "err ...") for each.
const { spawn } = require('child_process');

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SageInput {
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
      : name == "space" ? (ushort)0x20 : name == "down" ? (ushort)0x28 : name == "up" ? (ushort)0x26 : (ushort)0;
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
          else job.resolve();
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
