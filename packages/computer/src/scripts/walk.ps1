# The one definition of "the elements of a window, in order".
#
# Reading a window and clicking something in it have to agree on what `index 7` means, and the way
# they stop agreeing is by each having their own walk. So there is one: this file. Both the read
# and the act dot-source it, and a change to the filter or the order changes both at once.

# Windows PowerShell has no null-safe arithmetic, and a window that is not reporting its bounds
# hands back nothing where a number belongs. Zero is the honest value for a rectangle nobody
# described.
function To-Int([object]$value) {
    if ($null -eq $value) { return 0 }
    try { return [int]$value } catch { return 0 }
}

# Everything an operation might name. Control types outside this set are still descended into, so a
# container that publishes nothing does not hide the controls inside it.
function Get-ActionableControlTypes {
    return @(
        'Button', 'Edit', 'ComboBox', 'CheckBox', 'RadioButton', 'MenuItem', 'TabItem',
        'ListItem', 'TreeItem', 'Hyperlink', 'Slider', 'Spinner', 'SplitButton',
        'DataItem', 'HeaderItem', 'Text'
    )
}

# Depth-first, children pushed in reverse so the listing reads top-down in visual order.
# Returns @{ elements = @(...); truncated = $bool }.
function Get-FlattenedElements([System.Windows.Automation.AutomationElement]$root, [int]$maxNodes) {
    $actionable = Get-ActionableControlTypes
    $elements = @()
    $index = 0
    $truncated = $false

    $walk = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $stack = [System.Collections.Stack]::new()
    $stack.Push(@{ element = $root; depth = 0 })

    while ($stack.Count -gt 0) {
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
                        # Kept for the walk's own bookkeeping and stripped before the reply.
                        _node        = $node.element
                    }
                    $index++
                }
            } catch {
                # An element that dies mid-walk is skipped, not fatal: a window that is redrawing
                # loses nodes, and losing the whole read over one of them helps nobody.
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

    return @{ elements = $elements; truncated = $truncated }
}

# The element list with the live handles removed, for putting in a reply.
function Select-Reportable([object[]]$elements) {
    $out = @()
    foreach ($e in $elements) {
        $copy = [ordered]@{}
        foreach ($key in $e.Keys) {
            if ($key -eq '_node') { continue }
            $copy[$key] = $e[$key]
        }
        $out += $copy
    }
    return $out
}

# Bring a window to the front, because every operation in this plugin acts on the focused window.
function Set-WindowForeground([System.Windows.Automation.AutomationElement]$element) {
    try { $element.SetFocus() } catch { }

    $handle = $element.Current.NativeWindowHandle
    if (-not $handle) { return }
    Add-Type -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
'@ -Name Win32Focus -Namespace ComputerUse -ErrorAction SilentlyContinue

    $ptr = [System.IntPtr]$handle
    # 9 restores a minimised window without resizing one that is not, so a caller can act on a
    # window it can see rather than on one that is a taskbar button.
    [ComputerUse.Win32Focus]::ShowWindow($ptr, 9) | Out-Null
    [ComputerUse.Win32Focus]::SetForegroundWindow($ptr) | Out-Null
    Start-Sleep -Milliseconds 120
}
