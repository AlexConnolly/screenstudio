using System.Diagnostics;

namespace OpenStudio.Recorder;

/// <summary>
/// Session clock with pause support (§3.2: pauses become hard cuts in one continuous
/// timeline). All tracks consult it: while paused, video frames and audio bytes are
/// dropped and event timestamps freeze, so the recorded timeline simply skips the pause.
/// </summary>
public sealed class PauseClock
{
    private readonly object _lock = new();
    public long StartQpc { get; }
    private long _pausedAccum; // qpc ticks
    private long _pauseStart = -1;

    public PauseClock(long startQpc) => StartQpc = startQpc;

    public bool IsPaused
    {
        get { lock (_lock) return _pauseStart >= 0; }
    }

    public void Pause()
    {
        lock (_lock)
        {
            if (_pauseStart < 0) _pauseStart = Stopwatch.GetTimestamp();
        }
    }

    public void Resume()
    {
        lock (_lock)
        {
            if (_pauseStart >= 0)
            {
                _pausedAccum += Stopwatch.GetTimestamp() - _pauseStart;
                _pauseStart = -1;
            }
        }
    }

    /// <summary>Total paused time in ms (excluding a pause in progress — callers drop
    /// samples while paused, so in-progress time never reaches a timestamp).</summary>
    public double PausedTotalMs
    {
        get { lock (_lock) return _pausedAccum * 1000.0 / Stopwatch.Frequency; }
    }

    /// <summary>Adjusted session time in ms: real elapsed minus paused, frozen during pause.</summary>
    public double NowMs()
    {
        lock (_lock)
        {
            var reference = _pauseStart >= 0 ? _pauseStart : Stopwatch.GetTimestamp();
            return (reference - StartQpc - _pausedAccum) * 1000.0 / Stopwatch.Frequency;
        }
    }
}
