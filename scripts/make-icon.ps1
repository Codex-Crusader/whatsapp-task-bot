# Draws the bot icon (chat bubble with a check mark on a teal tile) and saves
# assets\icon.ico with sizes 16, 24, 32, 48, 64, 128, 256 (PNG entries).
# Run: powershell -ExecutionPolicy Bypass -File scripts\make-icon.ps1
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
New-Item -ItemType Directory -Force "$Root\assets" | Out-Null

function New-RoundRect([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = 2 * $r
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function Draw-Icon([int]$s) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)
  $k = $s / 256.0

  # Tile: teal gradient, rounded corners.
  $tile = New-RoundRect (8 * $k) (8 * $k) (240 * $k) (240 * $k) (56 * $k)
  $rect = New-Object System.Drawing.RectangleF 0, 0, $s, $s
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(255, 20, 184, 166)), ([System.Drawing.Color]::FromArgb(255, 15, 92, 110)), 45
  $g.FillPath($grad, $tile)

  # Chat bubble with a tail at the lower left.
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $bubble = New-RoundRect (48 * $k) (56 * $k) (160 * $k) (118 * $k) (40 * $k)
  $g.FillPath($white, $bubble)
  $tail = [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF (70 * $k), (160 * $k)),
    (New-Object System.Drawing.PointF (58 * $k), (206 * $k)),
    (New-Object System.Drawing.PointF (112 * $k), (168 * $k)))
  $g.FillPolygon($white, $tail)

  # Check mark inside the bubble.
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 15, 118, 110)), ([single][Math]::Max(1.6, 20 * $k))
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
  $check = [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF (88 * $k), (116 * $k)),
    (New-Object System.Drawing.PointF (116 * $k), (142 * $k)),
    (New-Object System.Drawing.PointF (170 * $k), (88 * $k)))
  $g.DrawLines($pen, $check)

  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return ,$ms.ToArray()
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$images = foreach ($s in $sizes) { ,(Draw-Icon $s) }

# ICO file: 6-byte header, 16-byte entry per image, then the PNG data.
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $len = $images[$i].Length
  $b = if ($s -ge 256) { 0 } else { $s }
  $w.Write([byte]$b); $w.Write([byte]$b); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$len); $w.Write([UInt32]$offset)
  $offset += $len
}
foreach ($img in $images) { $w.Write($img) }
$w.Flush()
[System.IO.File]::WriteAllBytes("$Root\assets\icon.ico", $out.ToArray())
[System.IO.File]::WriteAllBytes("$Root\assets\icon-256.png", $images[-1])
Write-Host "Saved $Root\assets\icon.ico"
