# Passed to Windows PowerShell in its process environment. Only the per-PTY UUID
# is substituted into this script. Paths and encrypted command data travel separately.
$global:serverDeckPending = $env:SERVERDECK_START_COMMAND
if ($null -ne $global:serverDeckPending) { Remove-Item Env:\SERVERDECK_START_COMMAND }
$global:serverDeckRunSavedCommand = $env:SERVERDECK_RUN_SAVED_COMMAND -eq '1'
$env:SERVERDECK_RUN_SAVED_COMMAND = $null
if ($env:SERVERDECK_START_DIRECTORY) {
    try { Set-Location -LiteralPath $env:SERVERDECK_START_DIRECTORY -ErrorAction Stop }
    catch {
        $global:serverDeckPending = $null
        Set-Location -LiteralPath $env:USERPROFILE -ErrorAction Stop
    }
    Remove-Item Env:\SERVERDECK_START_DIRECTORY
}
function global:prompt {
    $serverDeckDirectory = ''
    if ($PWD.Provider.Name -eq 'FileSystem') { $serverDeckDirectory = $PWD.ProviderPath }
    [Console]::Write(([string][char]27 + ']777;serverdeck-cwd;__TOKEN__;' + $serverDeckDirectory + [char]7))
    'PS ' + $executionContext.SessionState.Path.CurrentLocation + ('>' * ($nestedPromptLevel + 1)) + ' '
}
function global:Write-ServerDeckCommand([string] $blob) {
    [Console]::Write(([string][char]27 + ']777;serverdeck-command;__TOKEN__;' + $blob + [char]7))
}
function global:Test-ServerDeckLine([string] $line) {
    return ![string]::IsNullOrWhiteSpace($line) -and $line -notmatch '[\p{Cc}\p{Zl}\p{Zp}]' -and
        [Text.Encoding]::UTF8.GetByteCount($line) -le 4096
}
try {
    Import-Module PSReadLine -ErrorAction Stop
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    $global:serverDeckCommandPurpose = [Text.Encoding]::UTF8.GetBytes('ServerDeck.LocalTerminal.Command.v1')
    $global:serverDeckReadLine = (Get-Command PSConsoleHostReadLine -CommandType Function -ErrorAction Stop).ScriptBlock
    $global:serverDeckDefaultHistory = (Get-PSReadLineOption).AddToHistoryHandler
    function global:PSConsoleHostReadLine {
        $submitSavedLine = $global:serverDeckRunSavedCommand -and $global:serverDeckPending
        if ($submitSavedLine) {
            # Return the validated line through the host's normal command-input path.
            # PSReadLine's history initializes when the interactive editor first reads input.
            $line = $global:serverDeckPending
            [Console]::WriteLine($line)
        } else {
            $line = & $global:serverDeckReadLine
        }
        $global:serverDeckPending = $null
        if (![string]::IsNullOrWhiteSpace($line)) {
            $blob = ''
            try {
                $options = Get-PSReadLineOption
                if ((Test-ServerDeckLine $line) -and $options.HistorySaveStyle -ne 'SaveNothing' -and
                    $null -ne $global:serverDeckDefaultHistory -and
                    $options.AddToHistoryHandler -eq $global:serverDeckDefaultHistory -and
                    [string]$global:serverDeckDefaultHistory.Invoke($line) -in 'True','MemoryAndFile') {
                    $bytes = [Text.Encoding]::UTF8.GetBytes($line)
                    $blob = [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes, $global:serverDeckCommandPurpose, 'CurrentUser'))
                }
            } catch { Write-Warning 'ServerDeck could not capture this command for session save.' }
            Write-ServerDeckCommand $blob
        }
        return $line
    }
    if ($global:serverDeckPending) {
        $protected = $global:serverDeckPending
        $bytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($protected), $global:serverDeckCommandPurpose, 'CurrentUser')
        $line = [Text.Encoding]::UTF8.GetString($bytes)
        if (!(Test-ServerDeckLine $line)) { throw 'Invalid saved command' }
        $global:serverDeckPending = $line
        # The editor initializes its buffer on entry. Insert only inside its first
        # idle read, and give any input the user has already started precedence.
        if (!$global:serverDeckRunSavedCommand) {
            $null = Register-EngineEvent PowerShell.OnIdle -MaxTriggerCount 1 -Action {
                if ($global:serverDeckPending) {
                    $buffer = ''; $cursor = 0
                    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$buffer, [ref]$cursor)
                    if (!$buffer) {
                        [Microsoft.PowerShell.PSConsoleReadLine]::Insert($global:serverDeckPending)
                    }
                    $global:serverDeckPending = $null
                }
            } -ErrorAction Stop
        }
        Write-ServerDeckCommand $protected
        Remove-Variable line,bytes,protected
    }
} catch {
    $global:serverDeckPending = $null
    Write-Warning 'ServerDeck command capture or restore is unavailable in this shell.'
}
