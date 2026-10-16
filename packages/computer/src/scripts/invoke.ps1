# Act on one window: click something, type into it, press a key, or capture it.
#
# The hand. It reads the same tree `get-window-state` reads (through `walk.ps1`, so `index 7` means
# the same thing in both), and it does the one thing the read cannot: it moves the real mouse and
# keyboard, or captures real pixels. Because it changes the machine rather than describing it, the
# ordering below is the whole design and not an implementation detail:
#
#   1. resolve the window and check it is one this deployment allows, **before** anything is taken
#   2. for a click or a type, walk the tree *now* and confirm the element at `index` still is what
#      the caller said it was — a cached index addresses whatever is there today, which after a
#      redraw is a different button a few pixels away
#   3. only then act. A mismatch is refused, and refusing costs a re-read; acting on a moved index
#      costs a wrong click, and a wrong click in a file manager is not recoverable by re-reading.
#
# Windows-only by construction: UIA and SendInput are what "desktop" means here. There is no
# non-Windows branch, and pretending otherwise would be a wrapper that lies about half its calls.
#
# Output is JSON on the path in $args[0], the same file-not-stdout rule the read scripts follow —
# a window title or typed text with Chinese in it survives a UTF-8 file and does not survive a
# console codepage.

$ErrorActionPreference = 'Stop'

$out = $args[0]
$verb = $args[1]
$handle = [int64]$args[2]
$indexArg = $args[3]
$payloadPath = $args[4]

if (-not $out -or -not $verb) { throw 'invoke: need an output path and a verb' }
if (-not $handle) { throw 'invoke: need a window handle' }

$index = if ($indexArg -and $indexArg -ne '-1') { [int]$indexArg } else { -1 }
# The arguments arrive as a file, not as a command-line string. Typed text and window titles carry
# quotes, backslashes and Chinese, and every one of those is something a shell or PowerShell's own
# argument parser would rewrite on the way in — the same class of corruption the read scripts avoid
# by writing JSON to a file instead of to stdout. A path has none of that to get wrong.
$payload = [pscustomobject]@{}
if ($payloadPath -and (Test-Path -LiteralPath $payloadPath)) {
    $payload = [System.IO.File]::ReadAllText($payloadPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
}

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
. (Join-Path $PSScriptRoot 'walk.ps1')

# Write the reply and stop. Everything below funnels through here so there is exactly one shape of
# answer, and a refusal is a first-class one rather than an exception that loses the reason.
function Write-Reply([hashtable]$reply) {
    $json = $reply | ConvertTo-Json -Depth 6 -Compress
    [System.IO.File]::WriteAllText($out, $json, [System.Text.UTF8Encoding]::new($false))
    exit 0
}

# Refuse, and say what was expected against what was found — a caller that is told only "no" has to
# guess whether the index moved, the window closed, or the deployment forbade it.
function Refuse([string]$code, [string]$detail, [object]$window = $null, [object]$extra = $null) {
    $reply = [ordered]@{ ok = $false; verb = $verb; refused = $code; detail = $detail }
    if ($window -ne $null) { $reply.window = $window }
    if ($extra -ne $null) {
        foreach ($key in $extra.Keys) { $reply[$key] = $extra[$key] }
    }
    Write-Reply $reply
}

function Window-Of([System.Windows.Automation.AutomationElement]$element) {
    $c = $element.Current
    $r = $c.BoundingRectangle
    return [ordered]@{
        handle = [int64]$c.NativeWindowHandle
        title  = [string]$c.Name
        pid    = To-Int $c.ProcessId
        class  = [string]$c.ClassName
        x      = To-Int $r.X
        y      = To-Int $r.Y
        width  = To-Int $r.Width
        height = To-Int $r.Height
    }
}

# `FromHandle` throws (rather than returning null) for a handle that names no window — a stale
# handle from a window that has since closed is the ordinary case, so it is caught and refused the
# same way a missing window is, not allowed to become an unhandled exception with no reply written.
$window = $null
try {
    $window = [System.Windows.Automation.AutomationElement]::FromHandle([System.IntPtr]$handle)
} catch {
    Refuse 'window-gone' "handle $handle no longer names a window"
}
if ($null -eq $window) { Refuse 'window-gone' "no window with handle $handle" }
$windowInfo = Window-Of $window

# The deployment's allow-list, checked first. A window this deployment did not name is refused
# whether the ask is to read it or to touch it, because a screenshot of a forbidden window leaks it
# as surely as a click into it changes it. An empty list is "this deployment named none", and that
# is stated in the plugin's own documentation rather than guessed at here.
$applications = @()
if ($payload.PSObject.Properties.Name -contains 'applications' -and $payload.applications) {
    $applications = @($payload.applications)
}
if ($applications.Count -gt 0) {
    $title = [string]$windowInfo.title
    $allowed = $false
    foreach ($pattern in $applications) {
        if ($title -like "*$pattern*") { $allowed = $true; break }
    }
    if (-not $allowed) {
        Refuse 'app-not-allowed' "this deployment does not allow acting on a window titled '$title'" $windowInfo
    }
}

# The element a verb names. Resolved once, through the shared walk, for the three verbs that can
# address one: a click and a type must name one, and a capture may narrow to one. A key press
# addresses the window alone, and a capture with no index is the whole window.
#
# `screenshot` was left out of this the first time, and the failure was silent: the tool advertised
# an `index` and the script captured the whole window anyway, which is exactly the kind of quiet
# disagreement between what a tool says and what it does that this repository keeps writing down.
$element = $null
$at = $null
$needsElement = $verb -eq 'click' -or $verb -eq 'type_text' -or ($verb -eq 'screenshot' -and $index -ge 0)
if ($needsElement) {
    if (($verb -eq 'click' -or $verb -eq 'type_text') -and $index -lt 0) {
        Refuse 'element-not-found' "verb '$verb' needs an element index" $windowInfo
    }

    # No foregrounding here on purpose. Reading the tree does not need the window in front, and
    # bringing it forward is itself a change to the machine — a check that ends in a refusal must
    # leave nothing behind, so the window is raised inside the act, after the element is confirmed.
    $flattened = Get-FlattenedElements $window 2000
    foreach ($candidate in $flattened.elements) {
        if ([int]$candidate.index -eq $index) { $element = $candidate._node; $at = $candidate; break }
    }
    if ($null -eq $element) {
        Refuse 'element-not-found' "no element at index $index in this window now" $windowInfo @{ index = $index }
    }

    # The check the whole ordering exists for, and only for the verbs that *act* on what they name.
    # A capture changes nothing, so a moved index there is a stale picture rather than a wrong click.
    if ($verb -eq 'click' -or $verb -eq 'type_text') {
        $expected = $payload.expect
        $actual = [ordered]@{ index = $index; control = [string]$at.control; name = [string]$at.name }
        if ($expected -ne $null) {
            $wantControl = if ($expected.PSObject.Properties.Name -contains 'control') { [string]$expected.control } else { '' }
            $wantName = if ($expected.PSObject.Properties.Name -contains 'name') { [string]$expected.name } else { '' }
            $moved = $false
            if ($wantControl -ne '' -and $wantControl -ne $actual.control) { $moved = $true }
            if ($wantName -ne '' -and $wantName -ne $actual.name) { $moved = $true }
            if ($moved) {
                Refuse 'index-moved' "index $index is no longer '$wantControl'/'$wantName' — re-read the window and address it again" `
                    $windowInfo @{ expected = @{ control = $wantControl; name = $wantName }; actual = $actual }
            }
        }
        if (-not $at.enabled) {
            Refuse 'not-enabled' "index $index ('$($at.name)') is present but not enabled" $windowInfo @{ actual = $actual }
        }
    }
}

# A keyboard and a mouse, in one place. SendInput is used for keys because it can emit a character
# with no virtual key — which is every Chinese character — while `SendKeys`/`keybd_event` map to a
# keycode and lose exactly the input this repository keeps having to prove it keeps.
#
# The keystroke is built **in C#** rather than in PowerShell. A PowerShell value type is copied out
# on every read, so `$input.u.ki.wVk = 65` writes into a temporary and the `INPUT` that reaches
# `SendInput` is still all zeros — a silent no-op that reports success, which is exactly the failure
# this verb exists to avoid. The struct is filled where it is a real local, and one method call
# crosses the boundary.
Add-Type -Namespace ComputerUse -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public System.IntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Sequential)]
public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public System.IntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Explicit)]
public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
[StructLayout(LayoutKind.Sequential)]
public struct INPUT { public uint type; public INPUTUNION u; }
[DllImport("user32.dll", SetLastError = true)]
public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
[DllImport("user32.dll")]
public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")]
public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, System.UIntPtr dwExtraInfo);
// `MOUSEINPUT` is in the union for one reason: it is the larger of the two, so it fixes the size of
// `INPUT`. Without it the union would be `KEYBDINPUT`'s 24 bytes, `Marshal.SizeOf` would say 32, and
// `SendInput` would reject every call for a wrong `cbSize` — returning 0 and typing nothing, which
// is the silent no-op this whole verb is built to not do. The real `INPUT` is 40 bytes on x64.
// One key down or up. The primitive both the key press and the text path are built from.
public static uint Key(ushort vk, ushort scan, uint flags) {
    INPUT input = new INPUT();
    input.type = 1; // INPUT_KEYBOARD
    input.u.ki.wVk = vk;
    input.u.ki.wScan = scan;
    input.u.ki.dwFlags = flags;
    return SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT)));
}
'@

$KEYEVENTF_KEYUP = 0x0002
$KEYEVENTF_UNICODE = 0x0004

# One key down or up, by virtual key or by literal character. Returns how many events the system
# accepted: `SendInput` reports 0 for an event it refused, and a refusal that is not counted is how a
# tool comes to say "typed" over text that never arrived.
function Send-Key([int]$vk, [int]$scan, [int]$flags) {
    return [ComputerUse.Native]::Key([uint16]$vk, [uint16]$scan, [uint32]$flags)
}

# How long to leave between typed characters. Not a performance knob - a tolerance.
#
# With nothing between them, Windows 11 Notepad collapses a run of characters after a word boundary
# onto the last one: "a bcd" arrives as "a ddd", "ab cde" as "ab eee". It is not this capability's
# doing. A target that records its own `WM_CHAR` receives the exact sequence either way, gap or no
# gap, so the characters leave here correct and the editor is what mangles them. This was not
# guessed: an input-method theory was tested by switching the target to en-US (still wrong), and a
# whole-string batch was tried (worse, because it removes the separation entirely).
#
# So the gap is here to tolerate a target that cannot consume a burst, and it costs one delay per
# character. Only Notepad has been shown to need it; a plain WinForms text box takes the burst fine.
$TEXT_GAP_MS = 12

# A string as itself, one character at a time, with a gap the target can keep up with. Returns
# @{ sent; accepted } so the reply can carry whether the system took every event - the first thing to
# check when text arrives wrong.
function Send-Text([string]$text) {
    $sent = 0
    $accepted = 0
    foreach ($ch in $text.ToCharArray()) {
        [int]$code = [int][char]$ch
        $accepted += (Send-Key 0 $code $KEYEVENTF_UNICODE); $sent++
        $accepted += (Send-Key 0 $code ($KEYEVENTF_UNICODE -bor $KEYEVENTF_KEYUP)); $sent++
        Start-Sleep -Milliseconds $TEXT_GAP_MS
    }
    return @{ sent = $sent; accepted = [int]$accepted }
}

# A named key, or a single character, as the virtual key the keyboard would send.
function Get-VirtualKey([string]$name) {
    $key = $name.Trim().ToLowerInvariant()
    $named = @{
        'ctrl' = 0x11; 'control' = 0x11; 'alt' = 0x12; 'shift' = 0x10; 'win' = 0x5B
        'enter' = 0x0D; 'return' = 0x0D; 'tab' = 0x09; 'esc' = 0x1B; 'escape' = 0x1B
        'space' = 0x20; 'backspace' = 0x08; 'delete' = 0x2E; 'del' = 0x2E
        'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27
        'home' = 0x24; 'end' = 0x23; 'pageup' = 0x21; 'pagedown' = 0x22
        'insert' = 0x2D; 'capslock' = 0x14
    }
    if ($named.ContainsKey($key)) { return [int]$named[$key] }
    if ($key -match '^f([1-9]|1[0-2])$') { return 0x70 + ([int]$Matches[1] - 1) }
    if ($key.Length -eq 1) {
        $code = [int][char]$key.ToUpperInvariant()
        if (($code -ge 0x30 -and $code -le 0x39) -or ($code -ge 0x41 -and $code -le 0x5A)) { return $code }
    }
    throw "invoke: '$name' is not a key this understands"
}

$did = ''
switch ($verb) {
    'click' {
        # Prefer the accessibility action over the mouse. `InvokePattern` is the control performing
        # its own default action; a synthetic click at its centre is a second-best guess at what
        # that action is, and it lands wherever the control happens to be, including under something
        # else. Only when the control offers no invoke do we fall back to the pointer.
        $invoked = $false
        try {
            $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
            $pattern.Invoke()
            $invoked = $true
            $did = "invoked '$($at.name)' through its accessibility action"
        } catch { $invoked = $false }

        if (-not $invoked) {
            $cx = [int]($at.x + [math]::Floor($at.width / 2))
            $cy = [int]($at.y + [math]::Floor($at.height / 2))
            if ($at.width -le 0 -or $at.height -le 0) {
                Refuse 'no-invoke-pattern' "index $index offers no invoke and has no area to click" $windowInfo @{ actual = $actual }
            }
            Set-WindowForeground $window
            [ComputerUse.Native]::SetCursorPos($cx, $cy) | Out-Null
            Start-Sleep -Milliseconds 30
            [ComputerUse.Native]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)  # left down
            [ComputerUse.Native]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)  # left up
            $did = "clicked '$($at.name)' at $cx,$cy with the pointer (no accessibility action)"
        }
    }
    'type_text' {
        $text = if ($payload.PSObject.Properties.Name -contains 'text') { [string]$payload.text } else { '' }
        if ($text.Length -eq 0) { Refuse 'nothing-to-type' 'no text was given' $windowInfo @{ actual = $actual } }
        # Foreground the window *and* focus the field. Keystrokes go to whatever holds focus, so a
        # `SetFocus` that silently fails would type the caller's text into a different application —
        # the one failure of this verb nobody would forgive. Bringing the named window forward first
        # makes the worst case "into the right window, wrong field" instead.
        Set-WindowForeground $window
        try { $element.SetFocus(); Start-Sleep -Milliseconds 60 } catch { }
        $events = Send-Text $text
        $did = "typed $($text.Length) character(s) into '$($at.name)' [events accepted $($events.accepted)/$($events.sent)]"
    }
    'press_key' {
        $keySpec = if ($payload.PSObject.Properties.Name -contains 'key') { [string]$payload.key } else { '' }
        if ($keySpec.Length -eq 0) { Refuse 'nothing-to-press' 'no key was given' $windowInfo }
        Set-WindowForeground $window
        $parts = $keySpec -split '\+'
        $modifiers = @()
        # Everything before the last token is a modifier held down (`ctrl+s`); a lone key has none,
        # and slicing `0..0` here would have made the key its own modifier.
        for ($i = 0; $i -lt $parts.Count - 1; $i++) { $modifiers += Get-VirtualKey $parts[$i] }
        $mainVk = Get-VirtualKey $parts[-1]
        foreach ($vk in $modifiers) { Send-Key $vk 0 0 }
        Send-Key $mainVk 0 0
        Send-Key $mainVk 0 $KEYEVENTF_KEYUP
        for ($i = $modifiers.Count - 1; $i -ge 0; $i--) { Send-Key $modifiers[$i] 0 $KEYEVENTF_KEYUP }
        $did = "pressed $keySpec"
    }
    'click_at' {
        # The blind verb: it names a point, not an element, so there is nothing to re-read and
        # compare. What it CAN check is that the point lies inside the window the caller named —
        # which is the whole guard against a coordinate meant for one window landing on whatever
        # window has since moved over it.
        $px = [int]$payload.x
        $py = [int]$payload.y
        $double = $false
        if ($payload.PSObject.Properties.Name -contains 'double') { $double = [bool]$payload.double }

        Set-WindowForeground $window
        Start-Sleep -Milliseconds 80
        # Judged against the rectangle read AFTER raising it: a restored window sits somewhere other
        # than the minimised one the caller measured against.
        $now = Window-Of $window
        $inside = ($px -ge $now.x) -and ($py -ge $now.y) -and
                  ($px -lt ($now.x + $now.width)) -and ($py -lt ($now.y + $now.height))
        if (-not $inside) {
            Refuse 'point-outside-window' `
                "($px,$py) is outside window $handle, which is at $($now.x),$($now.y) $($now.width)x$($now.height)" `
                $now @{ point = @{ x = $px; y = $py } }
        }

        [ComputerUse.Native]::SetCursorPos($px, $py) | Out-Null
        Start-Sleep -Milliseconds 40
        [ComputerUse.Native]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)  # left down
        [ComputerUse.Native]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)  # left up
        if ($double) {
            # A desktop shortcut opens on the second click, so one click there only selects it.
            Start-Sleep -Milliseconds 60
            [ComputerUse.Native]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)
            [ComputerUse.Native]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)
        }
        $did = "clicked $px,$py$(if ($double) { ' twice' } else { '' }) in window $handle"
    }
    'screenshot' {
        $imagePath = if ($payload.PSObject.Properties.Name -contains 'imagePath') { [string]$payload.imagePath } else { '' }
        if ($imagePath.Length -eq 0) { Refuse 'no-image-path' 'no image path was given' $windowInfo }
        Add-Type -AssemblyName System.Drawing
        # A named element captures just that element's rectangle; without one, the whole window.
        $rect = if ($at -ne $null) { $at } else { $windowInfo }
        $w = [int]$rect.width
        $h = [int]$rect.height
        if ($w -le 0 -or $h -le 0) { Refuse 'nothing-to-capture' 'the window reports no area' $windowInfo }
        # A window inside a larger desktop: copy the screen region it occupies. Capture is by screen
        # coordinates, which is why the window had to be resolved to a rectangle first.
        $bmp = New-Object System.Drawing.Bitmap($w, $h)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen([int]$rect.x, [int]$rect.y, 0, 0, $bmp.Size)
        $bmp.Save($imagePath, [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose(); $bmp.Dispose()
        $did = "captured $w x $h to $imagePath"
    }
    default { Refuse 'unknown-verb' "invoke does not know the verb '$verb'" $windowInfo }
}

$reply = [ordered]@{ ok = $true; verb = $verb; did = $did; window = $windowInfo }
if ($at -ne $null) { $reply.at = [ordered]@{ index = $index; control = [string]$at.control; name = [string]$at.name; x = [int]$at.x; y = [int]$at.y } }
Write-Reply $reply
