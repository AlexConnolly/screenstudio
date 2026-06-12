using System.Runtime.InteropServices;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX.Direct3D11;
using WinRT;

namespace OpenStudio.Recorder.Capture;

[ComImport]
[Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IGraphicsCaptureItemInterop
{
    IntPtr CreateForWindow([In] IntPtr window, [In] ref Guid iid);
    IntPtr CreateForMonitor([In] IntPtr monitor, [In] ref Guid iid);
}

[ComImport]
[Guid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IDirect3DDxgiInterfaceAccess
{
    IntPtr GetInterface([In] ref Guid iid);
}

/// <summary>WinRT/COM glue between Windows.Graphics.Capture, D3D11 (SharpDX) and Media Foundation.</summary>
internal static class CaptureInterop
{
    [DllImport("d3d11.dll")]
    private static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);

    [DllImport("d3d11.dll")]
    private static extern int CreateDirect3D11SurfaceFromDXGISurface(IntPtr dxgiSurface, out IntPtr graphicsSurface);

    [DllImport("combase.dll", CharSet = CharSet.Unicode)]
    private static extern int WindowsCreateString(string sourceString, int length, out IntPtr hstring);

    [DllImport("combase.dll")]
    private static extern int WindowsDeleteString(IntPtr hstring);

    [DllImport("combase.dll")]
    private static extern int RoGetActivationFactory(IntPtr activatableClassId, ref Guid iid, out IntPtr factory);

    private static readonly Guid IidGraphicsCaptureItem = new("79C3F95B-31F7-4EC2-A464-632EF5D30760");
    private static readonly Guid IidD3D11Texture2D = new("6F15AAF2-D208-4E89-9AB4-489535D34F9C");

    public static GraphicsCaptureItem CreateItemForMonitor(IntPtr hmon) =>
        CreateItem(interop =>
        {
            var iid = IidGraphicsCaptureItem;
            return interop.CreateForMonitor(hmon, ref iid);
        });

    public static GraphicsCaptureItem CreateItemForWindow(IntPtr hwnd) =>
        CreateItem(interop =>
        {
            var iid = IidGraphicsCaptureItem;
            return interop.CreateForWindow(hwnd, ref iid);
        });

    private static GraphicsCaptureItem CreateItem(Func<IGraphicsCaptureItemInterop, IntPtr> create)
    {
        const string className = "Windows.Graphics.Capture.GraphicsCaptureItem";
        Marshal.ThrowExceptionForHR(WindowsCreateString(className, className.Length, out var hstr));
        try
        {
            var interopIid = typeof(IGraphicsCaptureItemInterop).GUID;
            Marshal.ThrowExceptionForHR(RoGetActivationFactory(hstr, ref interopIid, out var factoryPtr));
            try
            {
                var interop = (IGraphicsCaptureItemInterop)Marshal.GetObjectForIUnknown(factoryPtr);
                var abi = create(interop);
                try
                {
                    return GraphicsCaptureItem.FromAbi(abi);
                }
                finally
                {
                    Marshal.Release(abi);
                }
            }
            finally
            {
                Marshal.Release(factoryPtr);
            }
        }
        finally
        {
            WindowsDeleteString(hstr);
        }
    }

    public static IDirect3DDevice CreateWinRTDevice(SharpDX.DXGI.Device dxgiDevice)
    {
        Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.NativePointer, out var ptr));
        try
        {
            return MarshalInterface<IDirect3DDevice>.FromAbi(ptr);
        }
        finally
        {
            Marshal.Release(ptr);
        }
    }

    public static IDirect3DSurface CreateWinRTSurface(SharpDX.DXGI.Surface dxgiSurface)
    {
        Marshal.ThrowExceptionForHR(CreateDirect3D11SurfaceFromDXGISurface(dxgiSurface.NativePointer, out var ptr));
        try
        {
            return MarshalInterface<IDirect3DSurface>.FromAbi(ptr);
        }
        finally
        {
            Marshal.Release(ptr);
        }
    }

    /// <summary>Unwraps the D3D11 texture behind a WinRT surface (takes its own reference).</summary>
    public static SharpDX.Direct3D11.Texture2D GetTexture(IDirect3DSurface surface)
    {
        var access = surface.As<IDirect3DDxgiInterfaceAccess>();
        var iid = IidD3D11Texture2D;
        var ptr = access.GetInterface(ref iid);
        return new SharpDX.Direct3D11.Texture2D(ptr);
    }
}
