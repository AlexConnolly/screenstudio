using System.Runtime.InteropServices;

namespace OpenStudio.Recorder.Capture;

public sealed class MonitorDescriptor
{
    public IntPtr Handle { get; init; }
    public string DeviceName { get; init; } = "";
    public int X { get; init; }
    public int Y { get; init; }
    public int Width { get; init; }
    public int Height { get; init; }
    public bool IsPrimary { get; init; }
    public double Scale { get; init; } = 1.0;
    public double RefreshRate { get; init; }
}

public static class Monitors
{
    private delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref Rect rect, IntPtr data);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MonitorInfoEx
    {
        public int Size;
        public Rect Monitor;
        public Rect Work;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string DeviceName;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DevMode
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string dmDeviceName;
        public ushort dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
        public uint dmFields;
        public int dmPositionX, dmPositionY;
        public uint dmDisplayOrientation, dmDisplayFixedOutput;
        public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string dmFormName;
        public ushort dmLogPixels;
        public uint dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
        public uint dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
    }

    [DllImport("user32.dll")]
    private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfoW(IntPtr hMonitor, ref MonitorInfoEx info);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool EnumDisplaySettingsW(string deviceName, int modeNum, ref DevMode devMode);

    [DllImport("shcore.dll")]
    private static extern int GetDpiForMonitor(IntPtr hMonitor, int dpiType, out uint dpiX, out uint dpiY);

    private const uint MonitorInfoPrimary = 1;
    private const int EnumCurrentSettings = -1;

    public static List<MonitorDescriptor> All()
    {
        var list = new List<MonitorDescriptor>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr hMon, IntPtr _, ref Rect __, IntPtr ___) =>
        {
            var info = new MonitorInfoEx { Size = Marshal.SizeOf<MonitorInfoEx>() };
            if (!GetMonitorInfoW(hMon, ref info)) return true;

            double scale = 1.0;
            if (GetDpiForMonitor(hMon, 0 /* MDT_EFFECTIVE_DPI */, out var dpiX, out var _dpiY) == 0)
                scale = dpiX / 96.0;

            double refresh = 0;
            var devMode = new DevMode { dmSize = (ushort)Marshal.SizeOf<DevMode>() };
            if (EnumDisplaySettingsW(info.DeviceName, EnumCurrentSettings, ref devMode))
                refresh = devMode.dmDisplayFrequency;

            list.Add(new MonitorDescriptor
            {
                Handle = hMon,
                DeviceName = info.DeviceName,
                X = info.Monitor.Left,
                Y = info.Monitor.Top,
                Width = info.Monitor.Right - info.Monitor.Left,
                Height = info.Monitor.Bottom - info.Monitor.Top,
                IsPrimary = (info.Flags & MonitorInfoPrimary) != 0,
                Scale = scale,
                RefreshRate = refresh,
            });
            return true;
        }, IntPtr.Zero);

        return list.OrderByDescending(m => m.IsPrimary).ThenBy(m => m.X).ToList();
    }

    public static MonitorDescriptor? ByDeviceName(string? deviceName)
    {
        var all = All();
        if (string.IsNullOrEmpty(deviceName)) return all.FirstOrDefault();
        return all.FirstOrDefault(m => m.DeviceName == deviceName) ?? all.FirstOrDefault();
    }
}
