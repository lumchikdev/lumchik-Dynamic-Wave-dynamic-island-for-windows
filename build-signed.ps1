# Сборка установщика с подписью сертификатом nocturne.
# Запуск: правый клик → «Выполнить с помощью PowerShell» или в терминале: powershell -ExecutionPolicy Bypass -File build-signed.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$certs = Join-Path $root 'build\certs'
$env:CSC_LINK = Join-Path $certs 'nocturne-codesign.pfx'
$env:CSC_KEY_PASSWORD = [IO.File]::ReadAllText((Join-Path $certs 'pfx-password.txt'))
Push-Location $root
try { npm run dist } finally { Pop-Location; $env:CSC_LINK = ''; $env:CSC_KEY_PASSWORD = '' }
$exe = Get-ChildItem (Join-Path $root 'dist') -Filter 'DynamicWave-Setup-*.exe' | Sort-Object LastWriteTime | Select-Object -Last 1
$sig = Get-AuthenticodeSignature $exe.FullName
Write-Host "Подписано: $($exe.Name) — $($sig.SignerCertificate.Subject)"
