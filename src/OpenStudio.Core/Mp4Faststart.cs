using System.Buffers.Binary;

namespace OpenStudio.Core;

/// <summary>
/// Faststart remux: moves the moov (index) box in front of mdat so players can start
/// decoding immediately instead of reading the whole file first. Media Foundation's
/// MP4 sink writes moov at the end, which made long recordings take ages to open.
/// Pure box surgery: relocate moov, then shift every stco/co64 chunk offset by the
/// number of bytes mdat moved.
/// </summary>
public static class Mp4Faststart
{
    private sealed record Box(long Offset, long HeaderSize, long TotalSize, string Type);

    private static readonly HashSet<string> Containers = new()
    {
        "moov", "trak", "edts", "mdia", "minf", "dinf", "stbl", "mvex", "udta",
    };

    /// <summary>Rewrites <paramref name="path"/> with moov before mdat.
    /// Returns true if the file is faststart afterwards (or already was).</summary>
    public static bool Apply(string path)
    {
        try
        {
            List<Box> boxes;
            byte[] moov;
            using (var input = new FileStream(path, FileMode.Open, FileAccess.Read))
            {
                boxes = ReadTopLevelBoxes(input);
                var moovBox = boxes.FirstOrDefault(b => b.Type == "moov");
                var mdatBox = boxes.FirstOrDefault(b => b.Type == "mdat");
                if (moovBox == null || mdatBox == null) return false;
                if (moovBox.Offset < mdatBox.Offset) return true; // already faststart
                if (boxes.Count(b => b.Type == "mdat") != 1) return false; // unusual layout — leave it
                if (moovBox.TotalSize > 256 << 20) return false;

                moov = new byte[moovBox.TotalSize];
                input.Seek(moovBox.Offset, SeekOrigin.Begin);
                ReadExactly(input, moov);

                // mdat (and everything that references it) moves forward by moov's size.
                PatchChunkOffsets(moov, (long)moov.Length);

                var tmp = path + ".faststart";
                using (var output = new FileStream(tmp, FileMode.Create, FileAccess.Write))
                {
                    foreach (var box in boxes)
                    {
                        if (box.Type == "moov") continue;
                        if (box.Type == "mdat") output.Write(moov);
                        CopyRange(input, output, box.Offset, box.TotalSize);
                    }
                }
                input.Dispose();
                File.Move(tmp, path, overwrite: true);
                return true;
            }
        }
        catch
        {
            try { File.Delete(path + ".faststart"); } catch { }
            return false;
        }
    }

    private static List<Box> ReadTopLevelBoxes(Stream stream)
    {
        var boxes = new List<Box>();
        var header = new byte[16];
        long offset = 0;
        var length = stream.Length;
        while (offset + 8 <= length)
        {
            stream.Seek(offset, SeekOrigin.Begin);
            ReadExactly(stream, header.AsSpan(0, 8));
            long size = BinaryPrimitives.ReadUInt32BigEndian(header);
            var type = System.Text.Encoding.ASCII.GetString(header, 4, 4);
            long headerSize = 8;
            if (size == 1)
            {
                ReadExactly(stream, header.AsSpan(8, 8));
                size = (long)BinaryPrimitives.ReadUInt64BigEndian(header.AsSpan(8));
                headerSize = 16;
            }
            else if (size == 0)
            {
                size = length - offset; // box extends to end of file
            }
            if (size < headerSize || offset + size > length) throw new InvalidDataException("corrupt box");
            boxes.Add(new Box(offset, headerSize, size, type));
            offset += size;
        }
        return boxes;
    }

    /// <summary>Recursive descent through moov's container boxes, adding
    /// <paramref name="delta"/> to every stco (32-bit) / co64 (64-bit) entry.</summary>
    private static void PatchChunkOffsets(byte[] buffer, long delta)
    {
        Walk(8, buffer.Length); // skip moov's own 8-byte header

        void Walk(int start, int end)
        {
            var pos = start;
            while (pos + 8 <= end)
            {
                long size = BinaryPrimitives.ReadUInt32BigEndian(buffer.AsSpan(pos));
                var type = System.Text.Encoding.ASCII.GetString(buffer, pos + 4, 4);
                var headerSize = 8;
                if (size == 1)
                {
                    size = (long)BinaryPrimitives.ReadUInt64BigEndian(buffer.AsSpan(pos + 8));
                    headerSize = 16;
                }
                if (size < headerSize || pos + size > end) return; // defensive: stop on nonsense

                if (type == "stco")
                {
                    var count = BinaryPrimitives.ReadUInt32BigEndian(buffer.AsSpan(pos + 12));
                    for (var i = 0; i < count; i++)
                    {
                        var at = pos + 16 + i * 4;
                        var value = BinaryPrimitives.ReadUInt32BigEndian(buffer.AsSpan(at));
                        BinaryPrimitives.WriteUInt32BigEndian(buffer.AsSpan(at), (uint)(value + delta));
                    }
                }
                else if (type == "co64")
                {
                    var count = BinaryPrimitives.ReadUInt32BigEndian(buffer.AsSpan(pos + 12));
                    for (var i = 0; i < count; i++)
                    {
                        var at = pos + 16 + i * 8;
                        var value = BinaryPrimitives.ReadUInt64BigEndian(buffer.AsSpan(at));
                        BinaryPrimitives.WriteUInt64BigEndian(buffer.AsSpan(at), (ulong)((long)value + delta));
                    }
                }
                else if (Containers.Contains(type))
                {
                    Walk(pos + headerSize, (int)(pos + size));
                }
                pos += (int)size;
            }
        }
    }

    private static void CopyRange(Stream input, Stream output, long offset, long count)
    {
        input.Seek(offset, SeekOrigin.Begin);
        var buffer = new byte[1 << 20];
        while (count > 0)
        {
            var n = input.Read(buffer, 0, (int)Math.Min(buffer.Length, count));
            if (n <= 0) throw new EndOfStreamException();
            output.Write(buffer, 0, n);
            count -= n;
        }
    }

    private static void ReadExactly(Stream stream, Span<byte> target)
    {
        var read = 0;
        while (read < target.Length)
        {
            var n = stream.Read(target[read..]);
            if (n <= 0) throw new EndOfStreamException();
            read += n;
        }
    }
}
