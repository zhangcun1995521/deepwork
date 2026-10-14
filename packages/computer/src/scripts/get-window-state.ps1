# Read one window as a flat list of operable elements.
#
# This is the eye. On Windows the accessibility tree already describes what a user can act on —
# buttons, edits, menu items, with names and bounds — so automation reads that rather than
# guessing from pixels. A screenshot is a fallback for the few surfaces that publish nothing; it
# is not the primary channel, because it costs a model a hundred times more to look at and it can
# be wrong about a label it cannot read.
#
# Output is a flat list with a stable `index`, because that is what a later click names. The
# indices are positions in a deterministic pre-order walk: the same window read twice gives the
# same numbers, which is what lets a caller address something it saw in a previous call.

$ErrorActionPreference = 'Stop'
$out = $args[0]
$handle = [int64]$args[1]
$maxNodes = if ($args[2]) { [int]$args[2] } else { 400 }
if (-not $out -or -not $handle) { throw 'get-window-state: need an output path and a window handle' }

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$element = [System.Windows.Automation.AutomationElement]::FromHandle([System.IntPtr]$handle)
if ($null -eq $element) { throw "get-window-state: no window with handle $handle" }

function To-Int([object]$value) {
    if ($null -eq $value) { return 0 }
    try { return [int]$value } catch { return 0 }
}

# Everything an operation might name. Control types outside this set are still descended into, so
# a container that publishes nothing does not hide the controls inside it.
$actionable = @(
    'Button', 'Edit', 'ComboBox', 'CheckBox', 'RadioButton', 'MenuItem', 'TabItem',
    'ListItem', 'TreeItem', 'Hyperlink', 'Slider', 'Spinner', 'SplitButton',
    'DataItem', 'HeaderItem', 'Text'
)

$elements = @()
$index = 0
$truncated = $false

# Depth-first, children pushed in reverse so the listing reads top-down in visual order.
$walk = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$stack = [System.Collections.Stack]::new()
$stack.Push(@{ element = $element; depth = 0 })

while ($stack.Count -gt 0 -and -not $truncated) {
    $node = $stack.Pop()
    if ($node.depth -gt 0) {
        try {
            $current = $node.element.Current
            $control = [string]$current.ControlType.ProgrammaticName
            $control = $control -replace '^ControlType\.', ''
            $name = [string]$current.Name
            $rect = $current.BoundingRectangle

            $keep = $actionable -contains $control -or $name.Length -gt 0
            if ($keep) {
                if ($index -ge $maxNodes) { $truncated = $true; break }

                # A value pattern is how a text field tells you what is in it; most controls do
                # not have one, and asking is cheaper than a separate read per field.
                $value = $null
                try {
                    $pattern = $node.element.GetCurrentPattern(
                        [System.Windows.Automation.ValuePattern]::Pattern)
                    $value = [string]$pattern.Current.Value
                } catch { $value = $null }
                if ($value -ne $null -and $value.Length -gt 300) { $value = $value.Substring(0, 300) }

                $elements += [ordered]@{
                    index        = $index
                    depth        = [int]$node.depth
                    control      = $control
                    name         = $name
                    value        = $value
                    automationId = [string]$current.AutomationId
                    enabled      = [bool]$current.IsEnabled
                    offscreen    = [bool]$current.IsOffscreen
                    x            = To-Int $rect.X
                    y            = To-Int $rect.Y
                    width        = To-Int $rect.Width
                    height       = To-Int $rect.Height
                }
                $index++
            }
        } catch {
            # An element that dies mid-walk is skipped, not fatal: a window that is redrawing loses
            # nodes, and losing the whole read over one of them helps nobody.
        }
    }

    $child = $walk.GetFirstChild($node.element)
    $children = @()
    while ($child -ne $null) {
        $children += $child
        $child = $walk.GetNextSibling($child)
    }
    for ($i = $children.Count - 1; $i -ge 0; $i--) {
        $stack.Push(@{ element = $children[$i]; depth = $node.depth + 1 })
    }
}

$windowCurrent = $element.Current
$rect = $windowCurrent.BoundingRectangle

$json = [ordered]@{
    window = [ordered]@{
        handle = $handle
        title  = [string]$windowCurrent.Name
        pid    = To-Int $windowCurrent.ProcessId
        class  = [string]$windowCurrent.ClassName
        x      = To-Int $rect.X
        y      = To-Int $rect.Y
        width  = To-Int $rect.Width
        height = To-Int $rect.Height
    }
    count     = $elements.Count
    truncated = $truncated
    elements  = $elements
} | ConvertTo-Json -Depth 5 -Compress

[System.IO.File]::WriteAllText($out, $json, [System.Text.UTF8Encoding]::new($false))
