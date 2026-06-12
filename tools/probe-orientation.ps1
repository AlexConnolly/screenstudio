# Checks export orientation: the default backdrop is an indigo→sky gradient at 135°,
# so the top-left corner must be redder (indigo #4f46e5) than the bottom-right (sky #0ea5e9).
param([string]$Path)

Add-Type -AssemblyName PresentationCore, PresentationFramework, WindowsBase

$player = New-Object System.Windows.Media.MediaPlayer
$player.ScrubbingEnabled = $true
$player.Volume = 0
$opened = $false
$player.add_MediaOpened({ Set-Variable -Name opened -Value $true -Scope 1 })
$player.Open([Uri]$Path)
for ($i = 0; $i -lt 100 -and -not $opened; $i++) {
    Start-Sleep -Milliseconds 100
    [System.Windows.Threading.Dispatcher]::CurrentDispatcher.Invoke([Action]{}, [System.Windows.Threading.DispatcherPriority]::Background)
}
if (-not $opened) { Write-Output "DECODE FAILED"; exit 1 }
$player.Position = [TimeSpan]::FromSeconds(1)
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 100
    [System.Windows.Threading.Dispatcher]::CurrentDispatcher.Invoke([Action]{}, [System.Windows.Threading.DispatcherPriority]::Background)
}

$w = 320; $h = 180
$dv = New-Object System.Windows.Media.DrawingVisual
$dc = $dv.RenderOpen()
$dc.DrawVideo($player, (New-Object System.Windows.Rect(0, 0, $w, $h)))
$dc.Close()
$rtb = New-Object System.Windows.Media.Imaging.RenderTargetBitmap($w, $h, 96, 96, [System.Windows.Media.PixelFormats]::Pbgra32)
$rtb.Render($dv)
$px = New-Object byte[] ($w * $h * 4)
$rtb.CopyPixels($px, $w * 4, 0)

function Get-Pixel($x, $y) {
    $i = ($y * $w + $x) * 4
    # Pbgra32: B,G,R,A
    return @($px[$i+2], $px[$i+1], $px[$i])
}
$tl = Get-Pixel 4 4
$br = Get-Pixel ($w-5) ($h-5)
Write-Output ("top-left RGB: " + ($tl -join ",") + "   bottom-right RGB: " + ($br -join ","))
if ($tl[0] -gt $br[0] -and $br[2] -ge $tl[2] - 30) { Write-Output "ORIENTATION: correct (indigo top-left, sky bottom-right)" }
elseif ($br[0] -gt $tl[0]) { Write-Output "ORIENTATION: FLIPPED" }
else { Write-Output "ORIENTATION: inconclusive" }
$player.Close()
