using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using OpenStudio.Core;
using OpenStudio.Core.Models;

namespace OpenStudio.Recorder.Input;

public enum KeyPrivacyMode
{
    Full,
    ModifiersOnly,
    TicksOnly,
}

/// <summary>
/// Global low-level mouse/keyboard hooks (§2, §3.4) streaming to events.jsonl.
/// Runs its own message-loop thread (LL hooks require one). Coordinates are translated
/// into capture space (monitor origin subtracted), timestamps are QPC ms relative to the
/// session clock. Flushes every 500 ms so a crash loses at most ~1 s (§7.1).
/// </summary>
public sealed class InputEventLogger : IDisposable
{
    private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MsLlHookStruct
    {
        public Point Pt;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public IntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KbdLlHookStruct
    {
        public uint VkCode;
        public uint ScanCode;
        public uint Flags;
        public uint Time;
        public IntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CursorInfo
    {
        public int Size;
        public int Flags;
        public IntPtr Cursor;
        public Point ScreenPos;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Msg
    {
        public IntPtr Hwnd;
        public uint Message;
        public IntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public Point Pt;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookExW(int idHook, HookProc proc, IntPtr hMod, uint threadId);

    [DllImport("user32.dll")]
    private static extern bool UnhookWindowsHookEx(IntPtr hook);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hook, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandleW(string? name);

    [DllImport("user32.dll")]
    private static extern int GetMessageW(out Msg msg, IntPtr hwnd, uint min, uint max);

    [DllImport("user32.dll")]
    private static extern bool PostThreadMessageW(uint threadId, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern UIntPtr SetTimer(IntPtr hwnd, UIntPtr id, uint elapseMs, IntPtr proc);

    [DllImport("user32.dll")]
    private static extern bool GetCursorInfo(ref CursorInfo info);

    [DllImport("user32.dll")]
    private static extern IntPtr LoadCursorW(IntPtr instance, IntPtr name);

    private const int WhKeyboardLl = 13;
    private const int WhMouseLl = 14;
    private const uint WmQuit = 0x0012;
    private const uint WmTimer = 0x0113;
    private const uint WmMouseMove = 0x0200;
    private const uint WmLButtonDown = 0x0201, WmLButtonUp = 0x0202;
    private const uint WmRButtonDown = 0x0204, WmRButtonUp = 0x0205;
    private const uint WmMButtonDown = 0x0207, WmMButtonUp = 0x0208;
    private const uint WmMouseWheel = 0x020A;
    private const uint WmKeyDown = 0x0100, WmKeyUp = 0x0101, WmSysKeyDown = 0x0104, WmSysKeyUp = 0x0105;

    private static readonly (int Id, string Name)[] StandardCursors =
    {
        (32512, "arrow"), (32513, "ibeam"), (32514, "wait"), (32515, "cross"),
        (32516, "uparrow"), (32642, "nwse"), (32643, "nesw"), (32644, "we"),
        (32645, "ns"), (32646, "all"), (32648, "no"), (32649, "hand"),
        (32650, "appstarting"), (32651, "help"),
    };

    private readonly string _path;
    private readonly PauseClock _clock;
    private readonly Func<(int X, int Y)>? _originProvider; // window mode: origin moves
    private volatile int _originX;
    private volatile int _originY;
    private readonly KeyPrivacyMode _privacy;

    private readonly object _writeLock = new();
    private StreamWriter? _writer;
    private long _lastFlushQpc;
    private double _lastMoveT = double.MinValue;

    private Thread? _thread;
    private uint _threadId;
    private IntPtr _mouseHook;
    private IntPtr _keyHook;
    // Keep delegates alive for the lifetime of the hooks.
    private HookProc? _mouseProc;
    private HookProc? _keyProc;

    private Dictionary<IntPtr, string>? _cursorMap;
    private string _lastCursor = "";
    private bool _ctrl, _shift, _alt, _win;

    public InputEventLogger(
        string path, PauseClock clock, int originX, int originY,
        KeyPrivacyMode privacy, Func<(int X, int Y)>? originProvider = null)
    {
        _path = path;
        _clock = clock;
        _originX = originX;
        _originY = originY;
        _privacy = privacy;
        _originProvider = originProvider;
    }

    public void Start()
    {
        _writer = new StreamWriter(_path, append: false, new UTF8Encoding(false)) { AutoFlush = false };
        var ready = new ManualResetEventSlim();
        _thread = new Thread(() => Run(ready)) { IsBackground = true, Name = "OpenStudio.InputHooks" };
        _thread.Start();
        ready.Wait(TimeSpan.FromSeconds(5));
    }

    private void Run(ManualResetEventSlim ready)
    {
        _threadId = GetCurrentThreadId();
        _mouseProc = MouseProc;
        _keyProc = KeyProc;
        var module = GetModuleHandleW(null);
        _mouseHook = SetWindowsHookExW(WhMouseLl, _mouseProc, module, 0);
        _keyHook = SetWindowsHookExW(WhKeyboardLl, _keyProc, module, 0);
        _cursorMap = StandardCursors.ToDictionary(
            c => LoadCursorW(IntPtr.Zero, new IntPtr(c.Id)),
            c => c.Name);
        SetTimer(IntPtr.Zero, UIntPtr.Zero, 33, IntPtr.Zero); // cursor-type poll + flush tick
        ready.Set();

        while (GetMessageW(out var msg, IntPtr.Zero, 0, 0) > 0)
        {
            if (msg.Message == WmTimer)
            {
                if (_originProvider != null)
                {
                    var (ox, oy) = _originProvider();
                    _originX = ox;
                    _originY = oy;
                }
                PollCursorType();
                FlushIfDue();
            }
        }

        if (_mouseHook != IntPtr.Zero) UnhookWindowsHookEx(_mouseHook);
        if (_keyHook != IntPtr.Zero) UnhookWindowsHookEx(_keyHook);
    }

    private double NowMs() => _clock.NowMs();

    private void Emit(InputEvent ev)
    {
        if (_clock.IsPaused) return; // pauses are hard cuts — no events inside them (§3.2)
        lock (_writeLock)
        {
            if (_writer is null) return;
            _writer.WriteLine(Core.Models.EventLog.WriteLine(ev));
        }
    }

    private void FlushIfDue()
    {
        var now = Stopwatch.GetTimestamp();
        if ((now - _lastFlushQpc) * 1000.0 / Stopwatch.Frequency < 500) return;
        _lastFlushQpc = now;
        lock (_writeLock) _writer?.Flush();
    }

    private IntPtr MouseProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            var data = Marshal.PtrToStructure<MsLlHookStruct>(lParam);
            var t = NowMs();
            double x = data.Pt.X - _originX, y = data.Pt.Y - _originY;
            switch ((uint)wParam)
            {
                case WmMouseMove:
                    if (t - _lastMoveT >= 4) // cap at ~250 Hz; spec wants ≥ 60 Hz (§3.4)
                    {
                        _lastMoveT = t;
                        Emit(new InputEvent { T = t, K = "move", X = x, Y = y });
                    }
                    break;
                case WmLButtonDown: EmitButton(t, "down", 0, x, y); break;
                case WmLButtonUp: EmitButton(t, "up", 0, x, y); break;
                case WmRButtonDown: EmitButton(t, "down", 1, x, y); break;
                case WmRButtonUp: EmitButton(t, "up", 1, x, y); break;
                case WmMButtonDown: EmitButton(t, "down", 2, x, y); break;
                case WmMButtonUp: EmitButton(t, "up", 2, x, y); break;
                case WmMouseWheel:
                    Emit(new InputEvent { T = t, K = "wheel", D = (short)(data.MouseData >> 16), X = x, Y = y });
                    break;
            }
        }
        return CallNextHookEx(_mouseHook, nCode, wParam, lParam);
    }

    private void EmitButton(double t, string kind, int button, double x, double y) =>
        Emit(new InputEvent { T = t, K = kind, B = button, X = x, Y = y });

    private IntPtr KeyProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            var data = Marshal.PtrToStructure<KbdLlHookStruct>(lParam);
            var msg = (uint)wParam;
            var down = msg is WmKeyDown or WmSysKeyDown;
            var up = msg is WmKeyUp or WmSysKeyUp;
            if (down || up)
            {
                var vk = (int)data.VkCode;
                TrackModifiers(vk, down);
                Emit(BuildKeyEvent(NowMs(), down ? 1 : 0, vk));
            }
        }
        return CallNextHookEx(_keyHook, nCode, wParam, lParam);
    }

    private void TrackModifiers(int vk, bool down)
    {
        switch (vk)
        {
            case 0x10 or 0xA0 or 0xA1: _shift = down; break;
            case 0x11 or 0xA2 or 0xA3: _ctrl = down; break;
            case 0x12 or 0xA4 or 0xA5: _alt = down; break;
            case 0x5B or 0x5C: _win = down; break;
        }
    }

    private static bool IsModifierKey(int vk) =>
        vk is 0x10 or 0x11 or 0x12 or 0xA0 or 0xA1 or 0xA2 or 0xA3 or 0xA4 or 0xA5 or 0x5B or 0x5C;

    private static bool IsNonTextKey(int vk) =>
        vk is 0x1B or 0x09 or 0x0D                  // esc, tab, enter
        or (>= 0x70 and <= 0x87)                    // F1–F24
        or (>= 0x21 and <= 0x2E);                   // page/home/end/arrows/ins/del

    private InputEvent BuildKeyEvent(double t, int action, int vk)
    {
        var ev = new InputEvent { T = t, K = "key", A = action, Vk = -1 };
        if (_privacy == KeyPrivacyMode.TicksOnly) return ev; // anonymized typing ticks (§3.4)

        var mods = ModsString();
        var hasCombo = _ctrl || _alt || _win;
        if (_privacy == KeyPrivacyMode.Full || hasCombo || IsModifierKey(vk) || IsNonTextKey(vk))
        {
            ev.Vk = vk;
            ev.Mods = mods;
        }
        return ev;
    }

    private string? ModsString()
    {
        if (!(_ctrl || _shift || _alt || _win)) return null;
        var parts = new List<string>(4);
        if (_ctrl) parts.Add("ctrl");
        if (_shift) parts.Add("shift");
        if (_alt) parts.Add("alt");
        if (_win) parts.Add("win");
        return string.Join("+", parts);
    }

    private void PollCursorType()
    {
        var info = new CursorInfo { Size = Marshal.SizeOf<CursorInfo>() };
        if (!GetCursorInfo(ref info) || _cursorMap is null) return;
        var name = _cursorMap.TryGetValue(info.Cursor, out var n) ? n : "arrow";
        if (name == _lastCursor) return;
        _lastCursor = name;
        Emit(new InputEvent { T = NowMs(), K = "cursor", C = name });
    }

    public void Stop()
    {
        if (_threadId != 0) PostThreadMessageW(_threadId, WmQuit, IntPtr.Zero, IntPtr.Zero);
        _thread?.Join(TimeSpan.FromSeconds(3));
        lock (_writeLock)
        {
            _writer?.Flush();
            _writer?.Dispose();
            _writer = null;
        }
    }

    public void Dispose() => Stop();
}
