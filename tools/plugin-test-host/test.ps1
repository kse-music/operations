param([string]$Distro = 'Ubuntu-24.04', [ValidateSet('sdk','ui')][string]$Mode='sdk')
$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$stateDirectory = Join-Path $workspace '.local/plugin-13a'
New-Item -ItemType Directory -Path $stateDirectory,(Join-Path $stateDirectory 'tmp') -Force | Out-Null
$containerName = 'serverdeck-plugin13a-' + [Guid]::NewGuid().ToString('N')
$containerId = $null
$taskPassword = [Guid]::NewGuid().ToString('N') + 'SdA1!'
$keys = @('SERVERDECK_PLUGIN_TEST_PORT','SERVERDECK_PLUGIN_TEST_PASSWORD','SERVERDECK_PLUGIN_TEST_HOST_KEY','SERVERDECK_PLUGIN_TEST_CONTAINER_ID','SERVERDECK_PLUGIN_TEST_DISTRO','SERVERDECK_PLUGIN_SDK_WASM','TEMP','TMP')
$savedEnvironment = @{}
Push-Location $workspace
try {
    if ($Mode -eq 'sdk') {
        npm run plugins:build
        if ($LASTEXITCODE -ne 0) { throw 'Plugin and test fixture build failed' }
    } else {
        node tools/plugin-native-e2e.mjs --build
        if ($LASTEXITCODE -ne 0) { throw 'Native QA build failed' }
    }
} finally { Pop-Location }
foreach ($key in $keys) { $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
function Docker([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments) {
    $output = & wsl --distribution $Distro --exec docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Task container command failed; no user containers were modified.' }
    return $output
}
try {
    $env:SERVERDECK_PLUGIN_TEST_DISTRO = $Distro
    $containerId = (Docker @('run','--detach','--name',$containerName,'--label','cn.hiboot.qa=plugin-13a','--memory','256m','--cpus','1','--pids-limit','128','--security-opt','no-new-privileges','--cap-drop','ALL','--cap-add','CHOWN','--cap-add','SETUID','--cap-add','SETGID','--cap-add','SYS_CHROOT','--cap-add','NET_BIND_SERVICE','--cap-add','DAC_OVERRIDE','--tmpfs','/run:rw,nosuid,nodev,mode=755','--tmpfs','/home/plugin:rw,nodev,mode=755','--publish','127.0.0.1::22','serverdeck-plugin13a-test:13a')).Trim()
    $portLine = (Docker @('port',$containerId,'22/tcp')).Trim()
    if ($portLine -notmatch '^127\.0\.0\.1:(\d+)$') { throw 'Unexpected container SSH binding' }
    $env:SERVERDECK_PLUGIN_TEST_PORT = $Matches[1]
    $env:SERVERDECK_PLUGIN_TEST_CONTAINER_ID = $containerId
    # Feed ephemeral credentials through stdin only. Never argv, image layer, state file or stdout.
    $passwordProcessInfo = [System.Diagnostics.ProcessStartInfo]::new('wsl.exe')
    $passwordProcessInfo.UseShellExecute = $false
    $passwordProcessInfo.CreateNoWindow = $true
    $passwordProcessInfo.RedirectStandardInput = $true
    $passwordProcessInfo.StandardInputEncoding = [System.Text.UTF8Encoding]::new($false)
    foreach ($argument in @('--distribution',$Distro,'--exec','docker','exec','--interactive',$containerId,'chpasswd')) { $passwordProcessInfo.ArgumentList.Add($argument) }
    $passwordProcess = [System.Diagnostics.Process]::Start($passwordProcessInfo)
    try {
        $passwordProcess.StandardInput.Write("plugin:$taskPassword`n")
        $passwordProcess.StandardInput.Close()
        $passwordProcess.WaitForExit()
        if ($passwordProcess.ExitCode -ne 0) { throw 'Could not initialize ephemeral test account' }
    } finally { $passwordProcess.Dispose() }
    $env:SERVERDECK_PLUGIN_TEST_PASSWORD = $taskPassword
    $env:SERVERDECK_PLUGIN_TEST_HOST_KEY = (Docker @('exec',$containerId,'cat','/run/serverdeck/ssh_host_ed25519_key.pub')).Trim()
    # Docker publishes before sshd and WSL localhost forwarding are necessarily ready.
    $readyDeadline = [DateTime]::UtcNow.AddSeconds(15)
    $sshReady = $false
    $readinessError = 'No SSH banner received'
    while (-not $sshReady -and [DateTime]::UtcNow -lt $readyDeadline) {
        $readyClient = [System.Net.Sockets.TcpClient]::new()
        try {
            if ($readyClient.ConnectAsync('127.0.0.1', [int]$env:SERVERDECK_PLUGIN_TEST_PORT).Wait(500)) {
                $readyStream = $readyClient.GetStream()
                $readyStream.ReadTimeout = 500
                $readyBuffer = [byte[]]::new(256)
                $readyCount = $readyStream.Read($readyBuffer, 0, $readyBuffer.Length)
                $sshReady = [System.Text.Encoding]::ASCII.GetString($readyBuffer, 0, $readyCount).StartsWith('SSH-2.0-')
            }
        } catch { $readinessError = $_.Exception.Message }
        finally { $readyClient.Dispose() }
        if (-not $sshReady) { Start-Sleep -Milliseconds 100 }
    }
    if (-not $sshReady) { throw "Owned test SSH forwarding did not become ready: $readinessError" }
    $env:SERVERDECK_PLUGIN_SDK_WASM = Join-Path $stateDirectory 'sdk-guest/wasm32-unknown-unknown/release/serverdeck_diagnostics_example.wasm'
    $env:TEMP = Join-Path $stateDirectory 'tmp'
    $env:TMP = $env:TEMP
    @{ containerId=$containerId; containerName=$containerName; sshPort=[int]$env:SERVERDECK_PLUGIN_TEST_PORT; image='serverdeck-plugin13a-test:13a'; scope='owned isolated test container, no host mounts' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateDirectory 'linux-test-host.json') -Encoding utf8
    Push-Location $workspace
    try {
        if ($Mode -eq 'ui') { node tools/plugin-native-e2e.mjs }
        else { cargo test -p serverdeck-application --offline --locked -j 2 plugins::tests::linux_sdk_capability_roundtrip -- --ignored --nocapture }
        if ($LASTEXITCODE -ne 0) { throw 'Real Linux plugin integration test failed' }
    } finally { Pop-Location }
} catch {
    if ($containerId) { Docker @('logs','--tail','30',$containerId) }
    throw
} finally {
    if ($containerId) {
        $owned = (Docker @('inspect','--format','{{.Id}}|{{index .Config.Labels "cn.hiboot.qa"}}|{{.Name}}|{{.State.Running}}',$containerId)).Trim()
        if ($owned -ne "$containerId|plugin-13a|/$containerName|true" -and $owned -ne "$containerId|plugin-13a|/$containerName|false") { throw 'Container identity changed; cleanup refused' }
        Docker @('rm','--force',$containerId) | Out-Null
    }
    foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], 'Process') }
    $taskPassword = $null
}
