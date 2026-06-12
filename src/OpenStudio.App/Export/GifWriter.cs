using System.IO;

namespace OpenStudio.App.Export;

/// <summary>
/// Animated GIF89a encoder (§6): per-frame median-cut palette (≤256 colors),
/// Floyd–Steinberg dithering, LZW compression, infinite loop. Self-contained —
/// no FFmpeg. Frames are RGBA byte buffers from the shared render core.
/// </summary>
public sealed class GifWriter : IDisposable
{
    private readonly BinaryWriter _out;
    private readonly int _width;
    private readonly int _height;
    private readonly int _delayCs;
    private bool _headerWritten;

    public GifWriter(Stream stream, int width, int height, int fps)
    {
        _out = new BinaryWriter(stream);
        _width = width;
        _height = height;
        _delayCs = Math.Max(2, (int)Math.Round(100.0 / Math.Max(1, fps)));
    }

    public void AddFrame(byte[] rgba)
    {
        if (!_headerWritten)
        {
            WriteHeader();
            _headerWritten = true;
        }

        var (palette, indexed) = Quantize(rgba);

        // Graphic Control Extension (delay, no transparency).
        _out.Write((byte)0x21);
        _out.Write((byte)0xF9);
        _out.Write((byte)4);
        _out.Write((byte)0x04); // disposal: do not dispose
        _out.Write((ushort)_delayCs);
        _out.Write((byte)0);
        _out.Write((byte)0);

        // Image descriptor with a local color table.
        _out.Write((byte)0x2C);
        _out.Write((ushort)0);
        _out.Write((ushort)0);
        _out.Write((ushort)_width);
        _out.Write((ushort)_height);
        _out.Write((byte)(0x80 | 7)); // local table, 256 entries
        for (var i = 0; i < 256; i++)
        {
            var c = i < palette.Count ? palette[i] : 0;
            _out.Write((byte)(c >> 16));
            _out.Write((byte)(c >> 8));
            _out.Write((byte)c);
        }

        WriteLzw(indexed);
    }

    private void WriteHeader()
    {
        _out.Write("GIF89a"u8.ToArray());
        _out.Write((ushort)_width);
        _out.Write((ushort)_height);
        _out.Write((byte)0x70); // no global color table
        _out.Write((byte)0);
        _out.Write((byte)0);

        // NETSCAPE2.0 infinite loop.
        _out.Write((byte)0x21);
        _out.Write((byte)0xFF);
        _out.Write((byte)11);
        _out.Write("NETSCAPE2.0"u8.ToArray());
        _out.Write((byte)3);
        _out.Write((byte)1);
        _out.Write((ushort)0);
        _out.Write((byte)0);
    }

    // ---- Quantization: median cut + Floyd–Steinberg ----

    private (List<int> Palette, byte[] Indexed) Quantize(byte[] rgba)
    {
        // Sample pixels for the palette (every 3rd pixel keeps it fast).
        var samples = new List<int>(rgba.Length / 12);
        for (var i = 0; i < rgba.Length; i += 12)
            samples.Add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);

        var boxes = new List<List<int>> { samples };
        while (boxes.Count < 256)
        {
            // Split the box with the largest channel spread.
            var bestBox = -1;
            var bestSpread = 1; // require an actual spread
            var bestChannel = 0;
            for (var b = 0; b < boxes.Count; b++)
            {
                if (boxes[b].Count < 2) continue;
                int minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
                foreach (var c in boxes[b])
                {
                    var r = (c >> 16) & 255;
                    var g = (c >> 8) & 255;
                    var bl = c & 255;
                    if (r < minR) minR = r;
                    if (r > maxR) maxR = r;
                    if (g < minG) minG = g;
                    if (g > maxG) maxG = g;
                    if (bl < minB) minB = bl;
                    if (bl > maxB) maxB = bl;
                }
                var spreads = new[] { maxR - minR, maxG - minG, maxB - minB };
                for (var ch = 0; ch < 3; ch++)
                {
                    if (spreads[ch] > bestSpread)
                    {
                        bestSpread = spreads[ch];
                        bestBox = b;
                        bestChannel = ch;
                    }
                }
            }
            if (bestBox < 0) break;

            var shift = bestChannel == 0 ? 16 : bestChannel == 1 ? 8 : 0;
            var box = boxes[bestBox];
            box.Sort((a, b2) => ((a >> shift) & 255) - ((b2 >> shift) & 255));
            var mid = box.Count / 2;
            boxes[bestBox] = box.GetRange(0, mid);
            boxes.Add(box.GetRange(mid, box.Count - mid));
        }

        var palette = new List<int>(boxes.Count);
        foreach (var box in boxes)
        {
            long r = 0, g = 0, b = 0;
            foreach (var c in box)
            {
                r += (c >> 16) & 255;
                g += (c >> 8) & 255;
                b += c & 255;
            }
            var n = Math.Max(1, box.Count);
            palette.Add((int)((r / n) << 16 | (g / n) << 8 | (b / n)));
        }

        // Nearest-palette lookup with a 15-bit cache, then dither.
        var cache = new short[1 << 15];
        Array.Fill(cache, (short)-1);
        int Nearest(int r, int g, int b)
        {
            var key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
            var cached = cache[key];
            if (cached >= 0) return cached;
            var best = 0;
            var bestDist = int.MaxValue;
            for (var i = 0; i < palette.Count; i++)
            {
                var pr = (palette[i] >> 16) & 255;
                var pg = (palette[i] >> 8) & 255;
                var pb = palette[i] & 255;
                var d = (pr - r) * (pr - r) + (pg - g) * (pg - g) + (pb - b) * (pb - b);
                if (d < bestDist)
                {
                    bestDist = d;
                    best = i;
                }
            }
            cache[key] = (short)best;
            return best;
        }

        var indexed = new byte[_width * _height];
        // Error buffers for Floyd–Steinberg (current + next row), per channel.
        var err = new float[2, _width + 2, 3];
        for (var y = 0; y < _height; y++)
        {
            var cur = y & 1;
            var next = 1 - cur;
            for (var x = 0; x < _width + 2; x++)
            {
                err[next, x, 0] = 0;
                err[next, x, 1] = 0;
                err[next, x, 2] = 0;
            }
            for (var x = 0; x < _width; x++)
            {
                var p = (y * _width + x) * 4;
                var r = Math.Clamp((int)(rgba[p] + err[cur, x + 1, 0]), 0, 255);
                var g = Math.Clamp((int)(rgba[p + 1] + err[cur, x + 1, 1]), 0, 255);
                var b = Math.Clamp((int)(rgba[p + 2] + err[cur, x + 1, 2]), 0, 255);
                var idx = Nearest(r, g, b);
                indexed[y * _width + x] = (byte)idx;
                var c = palette[idx];
                float er = r - ((c >> 16) & 255);
                float eg = g - ((c >> 8) & 255);
                float eb = b - (c & 255);
                err[cur, x + 2, 0] += er * 7 / 16;
                err[cur, x + 2, 1] += eg * 7 / 16;
                err[cur, x + 2, 2] += eb * 7 / 16;
                err[next, x, 0] += er * 3 / 16;
                err[next, x, 1] += eg * 3 / 16;
                err[next, x, 2] += eb * 3 / 16;
                err[next, x + 1, 0] += er * 5 / 16;
                err[next, x + 1, 1] += eg * 5 / 16;
                err[next, x + 1, 2] += eb * 5 / 16;
                err[next, x + 2, 0] += er * 1 / 16;
                err[next, x + 2, 1] += eg * 1 / 16;
                err[next, x + 2, 2] += eb * 1 / 16;
            }
        }
        return (palette, indexed);
    }

    // ---- LZW (GIF variable-code-size) ----

    private void WriteLzw(byte[] indexed)
    {
        const int minCodeSize = 8;
        _out.Write((byte)minCodeSize);

        var clearCode = 1 << minCodeSize;        // 256
        var endCode = clearCode + 1;             // 257
        var dict = new Dictionary<long, int>();
        var nextCode = endCode + 1;
        var codeSize = minCodeSize + 1;

        var bitBuffer = 0L;
        var bitCount = 0;
        var block = new byte[255];
        var blockLen = 0;

        void EmitByte(byte b)
        {
            block[blockLen++] = b;
            if (blockLen == 255)
            {
                _out.Write((byte)255);
                _out.Write(block, 0, 255);
                blockLen = 0;
            }
        }

        void EmitCode(int code)
        {
            bitBuffer |= (long)code << bitCount;
            bitCount += codeSize;
            while (bitCount >= 8)
            {
                EmitByte((byte)(bitBuffer & 0xFF));
                bitBuffer >>= 8;
                bitCount -= 8;
            }
        }

        EmitCode(clearCode);
        var prefix = (int)indexed[0];
        for (var i = 1; i < indexed.Length; i++)
        {
            int k = indexed[i];
            var key = ((long)prefix << 8) | (uint)k;
            if (dict.TryGetValue(key, out var code))
            {
                prefix = code;
                continue;
            }
            EmitCode(prefix);
            dict[key] = nextCode++;
            // Decoder widens its read size when its next free slot hits 1<<codeSize.
            if (nextCode == 1 << codeSize && codeSize < 12) codeSize++;
            if (nextCode >= 4096)
            {
                EmitCode(clearCode);
                dict.Clear();
                nextCode = endCode + 1;
                codeSize = minCodeSize + 1;
            }
            prefix = k;
        }
        EmitCode(prefix);
        EmitCode(endCode);
        if (bitCount > 0) EmitByte((byte)(bitBuffer & 0xFF));
        if (blockLen > 0)
        {
            _out.Write((byte)blockLen);
            _out.Write(block, 0, blockLen);
        }
        _out.Write((byte)0); // block terminator
    }

    public void Dispose()
    {
        _out.Write((byte)0x3B); // trailer
        _out.Flush();
    }
}
