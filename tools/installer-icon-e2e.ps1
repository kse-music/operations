param(
    [string] $MakeNsis = (Join-Path $env:LOCALAPPDATA 'tauri/NSIS/makensis.exe'),
    [string] $ProbePath
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -LiteralPath (Join-Path $root 'apps/desktop/src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
$hook = Join-Path $root "apps/desktop/src-tauri/$($config.bundle.windows.nsis.installerHooks)"
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing, System.Windows.Forms @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public static class InstallerIconProbe {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct FileInfo {
        public IntPtr Icon;
        public int Index;
        public uint Attributes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string Type;
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SHGetFileInfo(string path, uint attributes, ref FileInfo info, uint size, uint flags);
    [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr icon);
    public static int Color(string path) {
        System.Windows.Forms.Application.DoEvents();
        var info = new FileInfo();
        if (SHGetFileInfo(path, 0, ref info, (uint)Marshal.SizeOf(info), 0x101) == IntPtr.Zero)
            throw new InvalidOperationException("Cannot read Shell icon: " + path);
        try {
            using (var icon = Icon.FromHandle(info.Icon))
            using (var bitmap = icon.ToBitmap())
                return bitmap.GetPixel(bitmap.Width / 2, bitmap.Height / 2).ToArgb();
        } finally { DestroyIcon(info.Icon); }
    }
}
public sealed class IconChangeObserver : System.Windows.Forms.NativeWindow, IDisposable {
    [StructLayout(LayoutKind.Sequential)]
    private struct Entry { public IntPtr Pidl; public int Recursive; }
    [DllImport("shell32.dll")]
    private static extern uint SHChangeNotifyRegister(IntPtr window, int sources, int events, uint message, int count, ref Entry entry);
    [DllImport("shell32.dll")]
    private static extern bool SHChangeNotifyDeregister(uint registration);
    private uint registration;
    public int Changes { get; private set; }
    public IconChangeObserver() {
        CreateHandle(new System.Windows.Forms.CreateParams());
        var entry = new Entry { Pidl = IntPtr.Zero, Recursive = 1 };
        registration = SHChangeNotifyRegister(Handle, 2, 0x08000000, 0x8001, 1, ref entry);
        if (registration == 0) throw new InvalidOperationException("Cannot register Shell cache notifications");
    }
    protected override void WndProc(ref System.Windows.Forms.Message message) {
        if (message.Msg == 0x8001) Changes++;
        base.WndProc(ref message);
    }
    public void Dispose() { SHChangeNotifyDeregister(registration); DestroyHandle(); }
}
'@

if ($ProbePath) {
    Write-Output ([InstallerIconProbe]::Color($ProbePath))
    exit 0
}
foreach ($required in @($hook, $compiler, $MakeNsis)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required tool or hook missing: $required" }
}
$qa = Join-Path $root ('.local/qa/installer-icons/run-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $qa | Out-Null

foreach ($variant in @('old', 'new')) {
    $bitmap = [Drawing.Bitmap]::new(32, 32)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $color = if ($variant -eq 'old') { [Drawing.Color]::Red } else { [Drawing.Color]::Lime }
    try {
        $graphics.Clear($color)
        $handle = $bitmap.GetHicon()
        $icon = [Drawing.Icon]::FromHandle($handle)
        $stream = [IO.File]::Create((Join-Path $qa "$variant.ico"))
        try { $icon.Save($stream) } finally { $stream.Dispose(); $icon.Dispose(); [InstallerIconProbe]::DestroyIcon($handle) | Out-Null }
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
}
$source = Join-Path $qa 'Fixture.cs'
Set-Content -LiteralPath $source -Encoding UTF8 -Value 'class Fixture { static void Main() {} }'
foreach ($variant in @('old', 'new')) {
    & $compiler /nologo /target:winexe "/out:$(Join-Path $qa "$variant.exe")" "/win32icon:$(Join-Path $qa "$variant.ico")" $source
    if ($LASTEXITCODE -ne 0) { throw "Fixture compilation failed: $variant" }
}
$expected = [InstallerIconProbe]::Color((Join-Path $qa 'new.exe'))
$oldColor = [InstallerIconProbe]::Color((Join-Path $qa 'old.exe'))
if ($expected -eq $oldColor) { throw 'Fixture icons must differ' }

function ConvertTo-NsisString([string] $value) { return $value.Replace('$', '$$').Replace('"', '$\"') }
function Get-Sha256([string] $path) {
    $hash = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($path)
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)) }
    finally { $stream.Dispose(); $hash.Dispose() }
}
$results = @()
foreach ($case in @(
    @{ name = 'control'; menu = ''; refresh = $false },
    @{ name = 'flat-menu'; menu = ''; refresh = $true },
    @{ name = 'custom-menu'; menu = 'Custom folder'; refresh = $true }
)) {
    $startMenu = $case.menu
    $name = $case.name
    $unicodeName = [string][char]0x4e2d + [char]0x6587
    $directory = Join-Path $qa "$name $unicodeName path"
    New-Item -ItemType Directory -Path $directory | Out-Null
    $installed = Join-Path $directory 'fixture.exe'
    Copy-Item -LiteralPath (Join-Path $qa 'old.exe') -Destination $installed
    if ([InstallerIconProbe]::Color($installed) -ne $oldColor) { throw 'Old installed icon did not load' }
    $installer = Join-Path $qa "$name.exe"
    $script = Join-Path $qa "$name.nsi"
    $product = 'ServerDeckIconFixture-' + [Guid]::NewGuid().ToString('N')
    $text = @'
Unicode true
RequestExecutionLevel user
SilentInstall silent
!define MAINBINARYNAME "fixture"
!define PRODUCTNAME "@PRODUCT@"
!define STARTMENUFOLDER "@MENU@"
!include "@HOOK@"
Name "ServerDeck icon fixture"
OutFile "@OUTPUT@"
InstallDir "@INSTALL@"
Var AppStartMenuFolder
Section
  StrCpy $AppStartMenuFolder "@MENU@"
  SetOutPath $INSTDIR
  File /oname=fixture.exe "@PAYLOAD@"
  @POSTINSTALL@
  !insertmacro ServerDeckRefreshIcon "$INSTDIR\missing.lnk"
SectionEnd
'@
    foreach ($entry in @{
        PRODUCT = $product; MENU = $startMenu; HOOK = $hook; OUTPUT = $installer
        INSTALL = $directory; PAYLOAD = (Join-Path $qa 'new.exe')
    }.GetEnumerator()) { $text = $text.Replace("@$($entry.Key)@", (ConvertTo-NsisString $entry.Value)) }
    $postInstall = if ($case.refresh) { '!insertmacro NSIS_HOOK_POSTINSTALL' } else { '' }
    $text = $text.Replace('@POSTINSTALL@', $postInstall)
    Set-Content -LiteralPath $script -Value $text -Encoding UTF8
    if ($case.refresh) {
        & $MakeNsis /V2 $script
        if ($LASTEXITCODE -ne 0) { throw "NSIS fixture compilation failed: $name" }
    }
    $observer = [IconChangeObserver]::new()
    try {
        if ($case.refresh) {
            $process = Start-Process -FilePath $installer -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
            if ($process.ExitCode -ne 0) { throw "NSIS fixture installation failed: $name ($($process.ExitCode))" }
        } else {
            Copy-Item -LiteralPath (Join-Path $qa 'new.exe') -Destination $installed -Force
        }
        $deadline = [DateTime]::UtcNow.AddMilliseconds($(if ($case.refresh) { 5000 } else { 500 }))
        do {
            [System.Windows.Forms.Application]::DoEvents()
            if ($observer.Changes -gt 0) { break }
            Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $deadline)
        if (($observer.Changes -gt 0) -ne $case.refresh) { throw "Unexpected Shell cache notification result: $name ($($observer.Changes))" }
    } finally { $observer.Dispose() }
    if ((Get-Sha256 $installed) -ne (Get-Sha256 (Join-Path $qa 'new.exe'))) { throw 'Installed payload differs' }
    # Shell image lists are per-process; use a fresh reader after the cache notification.
    $actual = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -ProbePath $installed
    if ($LASTEXITCODE -ne 0 -or ($case.refresh -and [int]$actual -ne $expected)) { throw "Shell still reports the old installed icon after the hook: $name" }
    if (Test-Path -LiteralPath (Join-Path $directory 'missing.lnk')) { throw 'Refresh created a missing shortcut' }
    $results += @{ case = $name; unicodeInstallPath = $true; cacheNotification = $case.refresh; newIconReadable = ([int]$actual -eq $expected); payloadPreserved = $true; missingShortcutPreserved = $true }
}
$results | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $qa 'results.json') -Encoding UTF8
Write-Output "PASS: $($results.Count) NSIS icon refresh cases. Evidence: $qa"
