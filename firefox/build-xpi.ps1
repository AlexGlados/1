$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.IO.Compression.FileSystem

$extension = Join-Path $PSScriptRoot 'extension'
$manifestPath = Join-Path $extension 'manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$dist = Join-Path $PSScriptRoot 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null

$xpi = Join-Path $dist "shkolkovo-firefox-$($manifest.version)-unsigned.xpi"
$temporary = Join-Path $dist ('.' + [Guid]::NewGuid().ToString('N') + '.tmp')
try {
    [IO.Compression.ZipFile]::CreateFromDirectory($extension, $temporary, 'Optimal', $false)
    Move-Item -LiteralPath $temporary -Destination $xpi -Force
    Write-Output $xpi
} finally {
    if (Test-Path -LiteralPath $temporary -PathType Leaf) {
        Remove-Item -LiteralPath $temporary
    }
}
