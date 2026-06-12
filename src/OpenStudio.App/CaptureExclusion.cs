using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

namespace OpenStudio.App;

/// <summary>Helpers for windows that must never appear in the recording (§3.2):
/// SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) + pixel-exact positioning.</summary>
internal static class CaptureExclusion
{
    private const uint WdaExcludeFromCapture = 0x11;
    private static readonly IntPtr HwndTopmost = new(-1);
    private const uint SwpShowWindow = 0x0040;

    [DllImport("user32.dll")]
    private static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

    public static void ExcludeFromCapture(Window window)
    {
        var hwnd = new WindowInteropHelper(window).Handle;
        if (hwnd != IntPtr.Zero) SetWindowDisplayAffinity(hwnd, WdaExcludeFromCapture);
    }

    /// <summary>Positions a window using physical pixels (monitor coordinates).</summary>
    public static void MovePixels(Window window, int x, int y, int width, int height)
    {
        var hwnd = new WindowInteropHelper(window).Handle;
        if (hwnd != IntPtr.Zero) SetWindowPos(hwnd, HwndTopmost, x, y, width, height, SwpShowWindow);
    }
}
