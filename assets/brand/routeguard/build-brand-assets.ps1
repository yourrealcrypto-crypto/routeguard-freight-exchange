param()

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName PresentationCore

$assetRoot = $PSScriptRoot
$fontRoot = "C:\Users\Sebas\AppData\Local\Microsoft\Windows\Fonts"
$wordmarkFont = Join-Path $fontRoot "Poppins-Medium.ttf"
$descriptorFont = Join-Path $fontRoot "Poppins-Regular.ttf"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$invariant = [Globalization.CultureInfo]::InvariantCulture

foreach ($font in @($wordmarkFont, $descriptorFont)) {
  if (-not (Test-Path -LiteralPath $font)) {
    throw "Required local Poppins font is unavailable: $font"
  }
}

function Get-OutlinedGlyphMarkup {
  param(
    [Parameter(Mandatory = $true)][string]$FontPath,
    [Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][double]$EmSize,
    [Parameter(Mandatory = $true)][double]$Tracking,
    [object[]]$TargetBounds
  )

  $fontUri = [Uri]("file:///" + ($FontPath -replace "\\", "/"))
  $typeface = New-Object Windows.Media.GlyphTypeface($fontUri)
  $advance = 0.0
  $visibleGlyphIndex = 0
  $paths = New-Object System.Collections.Generic.List[string]

  foreach ($character in $Text.ToCharArray()) {
    $glyphIndex = $typeface.CharacterToGlyphMap[[int][char]$character]
    $geometry = $typeface.GetGlyphOutline($glyphIndex, $EmSize, $EmSize)
    if ($geometry.Bounds.Width -gt 0) {
      $pathData = $geometry.ToString($invariant)
      if ($pathData.StartsWith("F1")) {
        $pathData = $pathData.Substring(2)
      }
      $escapedCharacter = [Security.SecurityElement]::Escape([string]$character)
      if ($TargetBounds) {
        $target = $TargetBounds[$visibleGlyphIndex]
        $scaleX = [double]$target[2] / $geometry.Bounds.Width
        $scaleY = [double]$target[3] / $geometry.Bounds.Height
        $translateX = [double]$target[0] - ($scaleX * $geometry.Bounds.X)
        $translateY = [double]$target[1] - ($scaleY * $geometry.Bounds.Y)
        $matrix = "matrix({0} 0 0 {1} {2} {3})" -f `
          $scaleX.ToString("0.######", $invariant), `
          $scaleY.ToString("0.######", $invariant), `
          $translateX.ToString("0.###", $invariant), `
          $translateY.ToString("0.###", $invariant)
        $paths.Add("    <path data-char=`"$escapedCharacter`" transform=`"$matrix`" d=`"$pathData`" />")
      } else {
        $offset = $advance.ToString("0.###", $invariant)
        $paths.Add("    <path data-char=`"$escapedCharacter`" transform=`"translate($offset 0)`" d=`"$pathData`" />")
      }
      $visibleGlyphIndex++
    }
    $advance += ($typeface.AdvanceWidths[$glyphIndex] * $EmSize) + $Tracking
  }

  return $paths -join "`n"
}

function Get-SymbolGroups {
  param(
    [Parameter(Mandatory = $true)][string]$GatewayColor,
    [Parameter(Mandatory = $true)][string]$InboundColor,
    [Parameter(Mandatory = $true)][string]$CheckColor,
    [Parameter(Mandatory = $true)][string]$RouteColor
  )

  return @"
  <g id="routeguard-gateway" fill="none" stroke="$GatewayColor" stroke-width="32" stroke-linecap="butt" stroke-linejoin="round">
    <path d="M130 119 V62 A46 46 0 0 1 176 16 H376 A46 46 0 0 1 422 62 V139" />
    <path d="M130 234 V267 A45 45 0 0 0 175 312 H377 A45 45 0 0 0 422 267 V228" />
  </g>
  <g id="routeguard-inbound" fill="$InboundColor">
    <circle cx="26" cy="184" r="26" />
    <circle cx="82" cy="184" r="11" />
    <circle cx="126" cy="184" r="11" />
    <circle cx="170" cy="184" r="11" />
  </g>
  <g id="routeguard-check" fill="none" stroke="$CheckColor" stroke-width="28" stroke-linecap="round" stroke-linejoin="round">
    <path d="M219 173 L258 214 L365 98" />
  </g>
  <g id="routeguard-verified-route" fill="$RouteColor" stroke="$RouteColor">
    <path d="M321 184 H1284" fill="none" stroke-width="20" stroke-linecap="butt" />
    <circle cx="1284" cy="184" r="21" stroke="none" />
  </g>
"@
}

function New-FormalSvg {
  param(
    [Parameter(Mandatory = $true)][string]$FileName,
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$GatewayColor,
    [Parameter(Mandatory = $true)][string]$InboundColor,
    [Parameter(Mandatory = $true)][string]$CheckColor,
    [Parameter(Mandatory = $true)][string]$RouteColor,
    [Parameter(Mandatory = $true)][string]$WordmarkColor,
    [Parameter(Mandatory = $true)][string]$DescriptorColor,
    [switch]$Editable,
    [switch]$NoDescriptor
  )

  $symbolGroups = Get-SymbolGroups -GatewayColor $GatewayColor -InboundColor $InboundColor -CheckColor $CheckColor -RouteColor $RouteColor

  if ($Editable) {
    $wordmark = @"
  <g id="routeguard-wordmark" fill="$WordmarkColor" aria-label="RouteGuard">
    <text x="468.37" y="136.12" font-family="Poppins" font-size="138" font-weight="500" letter-spacing="-4.9">RouteGuard</text>
  </g>
"@
    $descriptor = @"
  <g id="routeguard-descriptor" fill="$DescriptorColor" aria-label="FREIGHT EXCHANGE">
    <text x="475.15" y="267" font-family="Poppins" font-size="63" font-weight="400" letter-spacing="12.57">FREIGHT EXCHANGE</text>
  </g>
"@
  } else {
    # Target boxes are measured connected-component ink bounds, relative to
    # the 1305 x 329 visible-logo viewBox. Poppins supplies the curves; these
    # restrained per-glyph fits reproduce the approved raster's actual metrics.
    $wordmarkTargets = @(
      @(479, 38, 79, 99),  # R
      @(564, 62, 74, 76),  # o
      @(650, 63, 64, 75),  # u
      @(724, 42, 45, 96),  # t
      @(776, 62, 68, 76),  # e
      @(854, 36, 93, 102), # G
      @(961, 61, 69, 77),  # u
      @(1041, 60, 68, 78), # a
      @(1124, 60, 45, 77), # r
      @(1173, 34, 79, 104) # d
    )
    $descriptorTargets = @(
      @(480, 224, 32, 44),  # F
      @(529, 224, 36, 44),  # R
      @(582, 224, 32, 44),  # E
      @(632, 224, 7, 44),   # I
      @(657, 223, 40, 45),  # G
      @(715, 224, 36, 44),  # H
      @(767, 224, 35, 44),  # T
      @(844, 224, 32, 44),  # E
      @(891, 224, 39, 44),  # X
      @(941, 223, 39, 45),  # C
      @(997, 224, 35, 44),  # H
      @(1047, 224, 44, 44), # A
      @(1107, 224, 37, 44), # N
      @(1162, 223, 40, 45), # G
      @(1220, 224, 32, 44)  # E
    )
    $wordmarkPaths = Get-OutlinedGlyphMarkup -FontPath $wordmarkFont -Text "RouteGuard" -EmSize 138 -Tracking -4.9 -TargetBounds $wordmarkTargets
    $descriptorPaths = Get-OutlinedGlyphMarkup -FontPath $descriptorFont -Text "FREIGHT EXCHANGE" -EmSize 63 -Tracking 12.57 -TargetBounds $descriptorTargets
    $wordmark = @"
  <g id="routeguard-wordmark" fill="$WordmarkColor" aria-label="RouteGuard">
$wordmarkPaths
  </g>
"@
    $descriptor = @"
  <g id="routeguard-descriptor" fill="$DescriptorColor" aria-label="FREIGHT EXCHANGE">
$descriptorPaths
  </g>
"@
  }

  if ($NoDescriptor) {
    $descriptor = ""
  }

  $description = if ($NoDescriptor) {
    "RouteGuard compact horizontal lockup: inbound route, controlled gateway, verification check, confirmed route, and RouteGuard wordmark."
  } else {
    "RouteGuard Freight Exchange lockup: inbound route, controlled gateway, verification check, confirmed route, primary wordmark, and product descriptor."
  }

  $svg = @"
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1305 329" role="img" aria-labelledby="title description" shape-rendering="geometricPrecision">
  <title id="title">$Title</title>
  <desc id="description">$description</desc>
$symbolGroups
$wordmark
$descriptor
</svg>
"@

  [IO.File]::WriteAllText((Join-Path $assetRoot $FileName), $svg, $utf8NoBom)
}

function New-SymbolSvg {
  $svg = @"
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-labelledby="title description" shape-rendering="geometricPrecision">
  <title id="title">RouteGuard symbol</title>
  <desc id="description">Inbound route passing through a controlled gateway, verification check, and confirmed exit route.</desc>
  <g id="routeguard-gateway" fill="none" stroke="#11151D" stroke-width="24" stroke-linecap="butt" stroke-linejoin="round">
    <path d="M66 111 V70 A40 40 0 0 1 106 30 H166 A40 40 0 0 1 206 70 V113" />
    <path d="M66 151 V186 A40 40 0 0 0 106 226 H166 A40 40 0 0 0 206 186 V149" />
  </g>
  <g id="routeguard-inbound" fill="#11151D">
    <circle cx="14" cy="128" r="11" />
    <circle cx="39" cy="128" r="5" />
    <circle cx="58" cy="128" r="5" />
    <circle cx="77" cy="128" r="5" />
  </g>
  <g id="routeguard-check" fill="none" stroke="#10B981" stroke-width="18" stroke-linecap="round" stroke-linejoin="round">
    <path d="M93 121 L115 144 L168 87" />
  </g>
  <g id="routeguard-verified-route" fill="#10B981" stroke="#10B981">
    <path d="M151 128 H242" fill="none" stroke-width="12" stroke-linecap="butt" />
    <circle cx="242" cy="128" r="9" stroke="none" />
  </g>
</svg>
"@
  [IO.File]::WriteAllText((Join-Path $assetRoot "routeguard-symbol.svg"), $svg, $utf8NoBom)
}

New-FormalSvg `
  -FileName "routeguard-freight-exchange-master.svg" `
  -Title "RouteGuard Freight Exchange" `
  -GatewayColor "#11151D" -InboundColor "#11151D" `
  -CheckColor "#10B981" -RouteColor "#10B981" `
  -WordmarkColor "#11151D" -DescriptorColor "#60646C"

New-FormalSvg `
  -FileName "routeguard-freight-exchange-editable.svg" `
  -Title "RouteGuard Freight Exchange editable master" `
  -GatewayColor "#11151D" -InboundColor "#11151D" `
  -CheckColor "#10B981" -RouteColor "#10B981" `
  -WordmarkColor "#11151D" -DescriptorColor "#60646C" `
  -Editable

New-FormalSvg `
  -FileName "routeguard-horizontal-compact.svg" `
  -Title "RouteGuard compact horizontal lockup" `
  -GatewayColor "#11151D" -InboundColor "#11151D" `
  -CheckColor "#10B981" -RouteColor "#10B981" `
  -WordmarkColor "#11151D" -DescriptorColor "#60646C" `
  -NoDescriptor

New-FormalSvg `
  -FileName "routeguard-monochrome.svg" `
  -Title "RouteGuard Freight Exchange monochrome" `
  -GatewayColor "#11151D" -InboundColor "#11151D" `
  -CheckColor "#11151D" -RouteColor "#11151D" `
  -WordmarkColor "#11151D" -DescriptorColor "#11151D"

New-FormalSvg `
  -FileName "routeguard-reverse.svg" `
  -Title "RouteGuard Freight Exchange reverse" `
  -GatewayColor "#FFFFFF" -InboundColor "#FFFFFF" `
  -CheckColor "#10B981" -RouteColor "#10B981" `
  -WordmarkColor "#FFFFFF" -DescriptorColor "#FFFFFF"

New-SymbolSvg

Write-Output "RouteGuard SVG assets generated in $assetRoot"
