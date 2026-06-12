using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace OpenStudio.Recorder.Capture;

public sealed class WindowDescriptor
{
    public long Hwnd { get; init; }
    public string Title { get; init; } = "";
    public string ProcessName { get; init; } = "";
    public int X { get; init; }
    public int Y { get; init; }
    public int Width { get; init; }
    public int Height { get; init; }
}

/// <summary>Top-level windows eligible for single-window capture (§3.1).</summary>
public static class WindowEnum
{
    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    private static extern int GetWindowTextLengthW(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern long GetWindowLongPtrW(IntPtr hwnd, int index);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out Rect value, int size);

    private const int GwlExStyle = -20;
    private const long WsExToolWindow = 0x00000080;
    private const int DwmaCloaked = 14;
    private const int DwmaExtendedFrameBounds = 9;

    public static List<WindowDescriptor> TopLevel()
    {
        var list = new List<WindowDescriptor>();
        var ownPid = (uint)Environment.ProcessId;
        EnumWindows((hwnd, _) =>
        {
            if (!IsWindowVisible(hwnd)) return true;
            if (GetWindowTextLengthW(hwnd) == 0) return true;
            if ((GetWindowLongPtrW(hwnd, GwlExStyle) & WsExToolWindow) != 0) return true;
            if (DwmGetWindowAttribute(hwnd, DwmaCloaked, out int cloaked, 4) == 0 && cloaked != 0) return true;
            GetWindowThreadProcessId(hwnd, out var pid);
            if (pid == ownPid) return true;

            if (DwmGetWindowAttribute(hwnd, DwmaExtendedFrameBounds, out Rect r, Marshal.SizeOf<Rect>()) != 0)
                return true;
            var w = r.Right - r.Left;
            var h = r.Bottom - r.Top;
            if (w < 120 || h < 90) return true; // skip tiny utility windows

            var title = new StringBuilder(512);
            GetWindowTextW(hwnd, title, 512);
            string proc = "";
            try { proc = Process.GetProcessById((int)pid).ProcessName; } catch { }

            list.Add(new WindowDescriptor
            {
                Hwnd = hwnd.ToInt64(),
                Title = title.ToString(),
                ProcessName = proc,
                X = r.Left,
                Y = r.Top,
                Width = w,
                Height = h,
            });
            return true;
        }, IntPtr.Zero);
        return list;
    }

    /// <summary>Current window origin in physical pixels (for capture-space input coords).</summary>
    public static (int X, int Y) Origin(IntPtr hwnd)
    {
        if (DwmGetWindowAttribute(hwnd, DwmaExtendedFrameBounds, out Rect r, Marshal.SizeOf<Rect>()) == 0)
            return (r.Left, r.Top);
        return (0, 0);
    }

    [DllImport("user32.dll")]
    public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
}
