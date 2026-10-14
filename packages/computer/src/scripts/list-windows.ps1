# List the top-level windows.
#
# The first thing any desktop automation needs is the list, and the reason is not curiosity: an
# interaction has to name a window before it can read one, and a window's title is the only handle
# a caller has that means anything.
#
# Writes JSON to the path in $args[0] rather than to stdout. Windows PowerShell picks an output
# encoding from the console codepage, which turns a window title with Chinese in it into mojibake
# before Node ever sees it. A file written as UTF-8 has no codepage to get wrong.

param()

$ErrorActionPreference = 'Stop'
$out = $args[0]
if (-not $out) { throw 'list-windows: no output path given' }

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = [System.Windows.Automation.Condition]::TrueCondition
$children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
$foreground = [System.Windows.Automation.AutomationElement]::FocusedElement

# A window whose bounds are not reported casts to nothing, and one bad window must not cost the
# caller the whole list — it is the list they came for. Zero is the honest default for a rectangle
# nobody described, and the window is still addressable by its handle.
function To-Int([object]$value) {
    if ($null -eq $value) { return 0 }
    try { return [int]$value } catch { return 0 }
}

$windows = @()
$skipped = @()
foreach ($child in $children) {
    try {
        $current = $child.Current
        $handle = $current.NativeWindowHandle
        # A UIA child with no handle is an element the desktop owns, not a window a caller can address.
        if (-not $handle) { continue }

        $rect = $current.BoundingRectangle
        $isForeground = $false
        try {
            # FocusedElement's window handle identifies the foreground window without a P/Invoke.
            $walk = $foreground
            while ($walk -ne $null) {
                if ($walk.Current.NativeWindowHandle -eq $handle) { $isForeground = $true; break }
                $walk = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($walk)
            }
        } catch {
            $isForeground = $false
        }

        $windows += [ordered]@{
            handle     = [int64]$handle
            title      = [string]$current.Name
            pid        = To-Int $current.ProcessId
            class      = [string]$current.ClassName
            foreground = $isForeground
            x          = To-Int $rect.X
            y          = To-Int $rect.Y
            width      = To-Int $rect.Width
            height     = To-Int $rect.Height
        }
    } catch {
        # Counted rather than dropped in silence: a window the caller cannot see is a window they
        # will wonder about.
        $skipped += $_.Exception.Message
    }
}

$json = [ordered]@{
    screen = [ordered]@{
        # The root element's bounds are the desktop, so the screen size needs no second assembly.
        x      = To-Int $root.Current.BoundingRectangle.X
        y      = To-Int $root.Current.BoundingRectangle.Y
        width  = To-Int $root.Current.BoundingRectangle.Width
        height = To-Int $root.Current.BoundingRectangle.Height
    }
    windows = $windows
    skipped = $skipped
} | ConvertTo-Json -Depth 4 -Compress

[System.IO.File]::WriteAllText($out, $json, [System.Text.UTF8Encoding]::new($false))
