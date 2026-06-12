using System.Diagnostics;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace OpenStudio.Recorder.Audio;

public sealed class AudioDeviceInfo
{
    public string Id { get; init; } = "";
    public string Name { get; init; } = "";
    public bool IsDefault { get; init; }
}

public static class AudioDevices
{
    public static List<AudioDeviceInfo> CaptureDevices()
    {
        using var en = new MMDeviceEnumerator();
        string? defaultId = null;
        try
        {
            using var def = en.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications);
            defaultId = def.ID;
        }
        catch { /* no mic present */ }

        var list = new List<AudioDeviceInfo>();
        foreach (var d in en.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active))
        {
            list.Add(new AudioDeviceInfo { Id = d.ID, Name = d.FriendlyName, IsDefault = d.ID == defaultId });
            d.Dispose();
        }
        return list.OrderByDescending(d => d.IsDefault).ToList();
    }
}

/// <summary>
/// WASAPI capture to wav (§3.3: separate tracks, native device format — the editor and
/// exporter resample). StartOffsetMs aligns the track to the session master clock.
/// </summary>
public sealed class WavRecorder : IDisposable
{
    private readonly IWaveIn _capture;
    private readonly WaveFileWriter _writer;
    private readonly long _sessionStartQpc;
    private readonly PauseClock? _pauseClock;
    private readonly ManualResetEventSlim _stopped = new();
    private readonly WasapiOut? _silenceKeepalive;
    private long _bytesWritten;

    public double StartOffsetMs { get; private set; } = -1;

    private WavRecorder(IWaveIn capture, string path, long sessionStartQpc, WasapiOut? silenceKeepalive, PauseClock? pauseClock)
    {
        _capture = capture;
        _sessionStartQpc = sessionStartQpc;
        _silenceKeepalive = silenceKeepalive;
        _pauseClock = pauseClock;
        _writer = new WaveFileWriter(path, capture.WaveFormat);
        _capture.DataAvailable += OnData;
        _capture.RecordingStopped += (_, __) => _stopped.Set();
    }

    public static WavRecorder Microphone(string path, string? deviceId, long sessionStartQpc, PauseClock? pauseClock = null)
    {
        using var en = new MMDeviceEnumerator();
        var device = deviceId != null
            ? en.GetDevice(deviceId)
            : en.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications);
        return new WavRecorder(new WasapiCapture(device), path, sessionStartQpc, null, pauseClock);
    }

    public static WavRecorder SystemLoopback(string path, long sessionStartQpc, PauseClock? pauseClock = null)
    {
        // Loopback capture only produces buffers while something is rendering; play
        // silence on the default render device so the track stays continuous.
        WasapiOut? keepalive = null;
        try
        {
            keepalive = new WasapiOut(AudioClientShareMode.Shared, 200);
            keepalive.Init(new SilenceProvider(new WaveFormat(48000, 16, 2)));
            keepalive.Play();
        }
        catch
        {
            keepalive?.Dispose();
            keepalive = null;
        }
        return new WavRecorder(new WasapiLoopbackCapture(), path, sessionStartQpc, keepalive, pauseClock);
    }

    public void Start() => _capture.StartRecording();

    private void OnData(object? sender, WaveInEventArgs e)
    {
        // Pause = drop bytes; the wav stays continuous on the pause-adjusted timeline (§3.2).
        if (_pauseClock?.IsPaused == true) return;
        if (StartOffsetMs < 0)
        {
            var nowMs = (Stopwatch.GetTimestamp() - _sessionStartQpc) * 1000.0 / Stopwatch.Frequency;
            var bufferedMs = e.BytesRecorded * 1000.0 / _capture.WaveFormat.AverageBytesPerSecond;
            StartOffsetMs = Math.Max(0, nowMs - bufferedMs);
        }
        _writer.Write(e.Buffer, 0, e.BytesRecorded);
        _bytesWritten += e.BytesRecorded;
        if (_bytesWritten % (_capture.WaveFormat.AverageBytesPerSecond / 2) < e.BytesRecorded)
            _writer.Flush(); // crash safety (§7.1)
    }

    private int _stopOnce;

    public void Stop()
    {
        if (Interlocked.Exchange(ref _stopOnce, 1) == 1) return;
        try
        {
            _capture.StopRecording();
            _stopped.Wait(TimeSpan.FromSeconds(3));
        }
        finally
        {
            _silenceKeepalive?.Stop();
            _silenceKeepalive?.Dispose();
            _writer.Dispose();
            _capture.Dispose();
        }
    }

    public void Dispose() => Stop();
}
