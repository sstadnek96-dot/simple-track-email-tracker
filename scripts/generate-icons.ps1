$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$iconDir = Join-Path $root "extension\assets\icons"
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null

function New-Icon {
  param(
    [int]$Size,
    [string]$Path
  )

  $bitmap = New-Object System.Drawing.Bitmap $Size, $Size
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $rect = New-Object System.Drawing.RectangleF 0, 0, $Size, $Size
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(255, 31, 111, 235)), ([System.Drawing.Color]::FromArgb(255, 24, 201, 126)), 45
  $graphics.FillEllipse($brush, 0, 0, $Size - 1, $Size - 1)

  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ([Math]::Max(1.5, $Size * 0.08))
  $cap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.StartCap = $cap
  $pen.EndCap = $cap

  $graphics.DrawLine($pen, $Size * 0.26, $Size * 0.52, $Size * 0.44, $Size * 0.68)
  $graphics.DrawLine($pen, $Size * 0.44, $Size * 0.68, $Size * 0.76, $Size * 0.34)

  $dotBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 246, 248, 252))
  $graphics.FillEllipse($dotBrush, $Size * 0.67, $Size * 0.64, $Size * 0.18, $Size * 0.18)

  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)

  $dotBrush.Dispose()
  $pen.Dispose()
  $brush.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}

foreach ($size in @(16, 32, 48, 128)) {
  New-Icon -Size $size -Path (Join-Path $iconDir "icon-$size.png")
}

Write-Host "Generated extension icons in $iconDir"
