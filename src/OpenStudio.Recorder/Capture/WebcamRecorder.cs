using System.Diagnostics;
using Windows.Devices.Enumeration;
using Windows.Media.Capture;
using Windows.Media.MediaProperties;
using Windows.Storage;

namespace OpenStudio.Recorder.Capture;

public sealed class CameraDeviceInfo
{
    public string Id { get; init; } = "";
    public string Name { get; init; } = "";
}

/// <summary>
/// Webcam capture (§3.1): recorded simultaneously into its own camera.mp4 at the
/// device's native fps/resolution (§3.3) — never burned into the screen track, so the
/// overlay stays fully editable in post (§5.4). Start offset is logged against the
/// session QPC clock like every other track.
/// </summary>
public sealed class WebcamRecorder : IDisposable
{
    private readonly MediaCapture _capture;
    private LowLagMediaRecording? _recording;
    private readonly long _sessionStartQpc;

    public double StartOffsetMs { get; private set; } = -1;

    private WebcamRecorder(MediaCapture capture, long sessionStartQpc)
    {
        _capture = capture;
        _sessionStartQpc = sessionStartQpc;
    }

    public static List<CameraDeviceInfo> Devices()
    {
        try
        {
            var found = Task.Run(async () =>
                await DeviceInformation.FindAllAsync(DeviceClass.VideoCapture)).Result;
            return found.Select(d => new CameraDeviceInfo { Id = d.Id, Name = d.Name }).ToList();
        }
        catch
        {
            return new List<CameraDeviceInfo>();
        }
    }

    public static async Task<WebcamRecorder> StartAsync(string path, string? deviceId, long sessionStartQpc)
    {
        if (string.IsNullOrEmpty(deviceId))
        {
            var devices = await DeviceInformation.FindAllAsync(DeviceClass.VideoCapture);
            deviceId = devices.FirstOrDefault()?.Id
                ?? throw new InvalidOperationException("No webcam found.");
        }

        var capture = new MediaCapture();
        await capture.InitializeAsync(new MediaCaptureInitializationSettings
        {
            VideoDeviceId = deviceId,
            StreamingCaptureMode = StreamingCaptureMode.Video, // voice comes from the mic track
            MediaCategory = MediaCategory.Other,
        });

        var recorder = new WebcamRecorder(capture, sessionStartQpc);
        try
        {
            // Auto profile records at the camera's native format (§3.3).
            var profile = MediaEncodingProfile.CreateMp4(VideoEncodingQuality.Auto);
            profile.Audio = null;

            await using (File.Create(path)) { }
            var file = await StorageFile.GetFileFromPathAsync(Path.GetFullPath(path));
            recorder._recording = await capture.PrepareLowLagRecordToStorageFileAsync(profile, file);
            recorder.StartOffsetMs =
                (Stopwatch.GetTimestamp() - sessionStartQpc) * 1000.0 / Stopwatch.Frequency;
            await recorder._recording.StartAsync();
            return recorder;
        }
        catch
        {
            recorder.Dispose();
            throw;
        }
    }

    public async Task PauseAsync()
    {
        if (_recording != null)
        {
            try { await _recording.PauseAsync(Windows.Media.Devices.MediaCapturePauseBehavior.RetainHardwareResources); }
            catch { }
        }
    }

    public async Task ResumeAsync()
    {
        if (_recording != null)
        {
            try { await _recording.ResumeAsync(); } catch { }
        }
    }

    public async Task StopAsync()
    {
        if (_recording != null)
        {
            try
            {
                await _recording.StopAsync();
                await _recording.FinishAsync();
            }
            catch { /* device unplugged mid-recording — keep what we have */ }
            _recording = null;
        }
    }

    public void Dispose()
    {
        try { _capture.Dispose(); } catch { }
    }
}
