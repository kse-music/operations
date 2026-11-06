param(
    [Parameter(Mandatory)][int]$AppProcessId,
    [Parameter(Mandatory)][string]$DialogTitle,
    [string]$Destination
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$automation = [System.Windows.Automation.AutomationElement]
$process = [System.Windows.Automation.PropertyCondition]::new($automation::ProcessIdProperty, $AppProcessId)
$title = [System.Windows.Automation.PropertyCondition]::new($automation::NameProperty, $DialogTitle)
$condition = [System.Windows.Automation.AndCondition]::new($process, $title)
$dialog = $null
$deadline = [DateTime]::UtcNow.AddSeconds(10)
while (-not $dialog -and [DateTime]::UtcNow -lt $deadline) {
    $dialog = $automation::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
    if (-not $dialog) {
        $owner = Get-Process -Id $AppProcessId
        if ($owner.MainWindowHandle -ne [IntPtr]::Zero) {
            $window = $automation::FromHandle($owner.MainWindowHandle)
            $dialog = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
        }
    }
    if (-not $dialog) { Start-Sleep -Milliseconds 100 }
}
if (-not $dialog) { throw "Save dialog did not open in isolated process $AppProcessId" }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ServerDeckSaveDialog {
    private delegate bool EnumChildProc(IntPtr child, IntPtr data);
    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr parent, EnumChildProc callback, IntPtr data);
    [DllImport("user32.dll")]
    private static extern int GetDlgCtrlID(IntPtr child);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    private static extern int GetClassName(IntPtr child, StringBuilder name, int capacity);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr SendMessageTimeout(IntPtr h, uint message, IntPtr wParam,
        string text, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool PostMessage(IntPtr h, uint message, IntPtr wParam, IntPtr lParam);

    public static IntPtr FindControl(IntPtr parent, int id, string expectedClass) {
        IntPtr control = IntPtr.Zero;
        EnumChildWindows(parent, delegate(IntPtr child, IntPtr data) {
            if (GetDlgCtrlID(child) != id) return true;
            var name = new StringBuilder(64);
            GetClassName(child, name, name.Capacity);
            if (name.ToString() != expectedClass) return true;
            control = child;
            return false;
        }, IntPtr.Zero);
        return control;
    }
}
'@
$handle = [IntPtr]$dialog.Current.NativeWindowHandle
if ($handle -eq [IntPtr]::Zero) { throw 'Save dialog did not expose a window handle' }
if ($Destination) {
    # The Windows common dialog uses control 1001 for the filename and IDOK for Save.
    $fileName = [ServerDeckSaveDialog]::FindControl($handle, 1001, 'Edit')
    $save = [ServerDeckSaveDialog]::FindControl($handle, 1, 'Button')
    if ($fileName -eq [IntPtr]::Zero -or $save -eq [IntPtr]::Zero) { throw 'Save dialog filename or Save button is missing' }
    $result = [IntPtr]::Zero
    # WM_SETTEXT targets the filename edit directly without changing desktop focus.
    $sent = [ServerDeckSaveDialog]::SendMessageTimeout($fileName, 0x000C, [IntPtr]::Zero, $Destination, 2, 2000, [ref]$result)
    if ($sent -eq [IntPtr]::Zero -or $result -eq [IntPtr]::Zero) { throw 'Could not fill the isolated save dialog' }
    $posted = [ServerDeckSaveDialog]::PostMessage($handle, 0x0111, [IntPtr]1, $save)
} else {
    $posted = [ServerDeckSaveDialog]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
}
if (-not $posted) { throw 'Could not operate the isolated save dialog' }
