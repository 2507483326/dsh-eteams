$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$man = 'C:\eTeam\roles-manifest'
$srcRoot = 'C:\Users\epat\Downloads\agency-agents-zh-main'
$rosterPath = 'C:\eTeam\.eteams\roster.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)

# 1. verify all 21 batch manifests exist
$expectedBatches = 0..20 | ForEach-Object { 'batch-{0:D2}' -f $_ }
$missing = @($expectedBatches | Where-Object { -not (Test-Path (Join-Path $man ($_ + '.json'))) })
if ($missing.Count -gt 0) { throw ('missing manifests: ' + ($missing -join ', ')) }

# 2. load entries
$entries = New-Object System.Collections.ArrayList
foreach ($b in $expectedBatches) {
  $jsonText = [System.IO.File]::ReadAllText((Join-Path $man ($b + '.json'))).TrimStart([char]0xFEFF)
  $arr = $jsonText | ConvertFrom-Json
  foreach ($e in @($arr)) { [void]$entries.Add($e) }
}
Write-Output ('entries loaded: ' + $entries.Count)
if ($entries.Count -ne 186) { throw ('expected 186 entries, got ' + $entries.Count) }

# 3. coverage check vs input lists
$expectedFiles = New-Object System.Collections.Generic.HashSet[string]
Get-ChildItem (Join-Path $man 'inputs') -Filter 'batch-*.txt' | ForEach-Object {
  foreach ($line in [System.IO.File]::ReadAllLines($_.FullName, $utf8)) {
    if ($line.Trim()) { [void]$expectedFiles.Add((($line -split "`t")[0])) }
  }
}
$manifestFiles = New-Object System.Collections.Generic.HashSet[string]
foreach ($e in $entries) { [void]$manifestFiles.Add(([string]$e.file)) }
$notInManifest = @($expectedFiles | Where-Object { -not $manifestFiles.Contains($_) })
$notInInputs = @($manifestFiles | Where-Object { -not $expectedFiles.Contains($_) })
if ($notInManifest.Count -gt 0 -or $notInInputs.Count -gt 0) {
  Write-Output ('in inputs but not manifest: ' + ($notInManifest -join ', '))
  Write-Output ('in manifest but not inputs: ' + ($notInInputs -join ', '))
  throw 'coverage mismatch'
}
Write-Output 'coverage OK (186/186)'

# 4. name & field checks
$dups = @($entries | Group-Object name | Where-Object { $_.Count -gt 1 })
if ($dups.Count -gt 0) { $dups | ForEach-Object { Write-Output ('DUP: ' + $_.Name) }; throw 'duplicate names' }
$forbidden = @('项目牧羊人','前端开发者','UI 设计师','趣味注入师','后端架构师','角色构建师')
$bad = @($entries | Where-Object { $forbidden -contains ([string]$_.name) })
if ($bad.Count -gt 0) { $bad | ForEach-Object { Write-Output ('FORBIDDEN: ' + $_.name) }; throw 'forbidden names' }
$emptyFields = @($entries | Where-Object { -not ([string]$_.name).Trim() -or -not ([string]$_.duty).Trim() -or -not ([string]$_.style).Trim() -or -not ([string]$_.skills).Trim() })
if ($emptyFields.Count -gt 0) { $emptyFields | ForEach-Object { Write-Output ('EMPTY FIELDS: ' + $_.file) }; throw 'empty required fields' }
Write-Output 'name & field checks OK'

# 5. build merged member list
$roster = [System.IO.File]::ReadAllText($rosterPath).TrimStart([char]0xFEFF) | ConvertFrom-Json
$keep = @($roster.members | Where-Object { $_.name -ne '__import_probe__' })
Write-Output ('existing kept: ' + $keep.Count)
$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$all = New-Object System.Collections.ArrayList
foreach ($m in $keep) { [void]$all.Add($m) }
foreach ($e in $entries) {
  $fullPath = Join-Path $srcRoot (([string]$e.file) -replace '/', '\')
  if (-not (Test-Path $fullPath)) { throw ('source file missing: ' + $fullPath) }
  $personaMd = [System.IO.File]::ReadAllText($fullPath).TrimStart([char]0xFEFF)
  $rules = @($e.rules | Where-Object { $_ -and ([string]$_).Trim() })
  $obj = [ordered]@{
    name = [string]$e.name
    role = [string]$e.dept
    duty = [string]$e.duty
    style = [string]$e.style
    skills = [string]$e.skills
  }
  if ($rules.Count -gt 0) { $obj['rules'] = @($rules | ForEach-Object { [string]$_ }) }
  $obj['personaMd'] = $personaMd
  $obj['avatar'] = [ordered]@{ seed = Get-Random -Minimum 1 -Maximum 1000; salt = Get-Random -Minimum 1 -Maximum 100 }
  $obj['updatedAt'] = $now
  [void]$all.Add([pscustomobject]$obj)
}
Write-Output ('total members after merge: ' + $all.Count)

# 6. write BOM-less JSON
$jsonOut = @{ schemaVersion = 1; members = $all } | ConvertTo-Json -Depth 20 -Compress
[System.IO.File]::WriteAllText($rosterPath, $jsonOut, $utf8)
$fi = New-Object System.IO.FileInfo($rosterPath)
Write-Output ('roster.json written, bytes: ' + $fi.Length)

# 7. re-validate
$check = [System.IO.File]::ReadAllText($rosterPath).TrimStart([char]0xFEFF) | ConvertFrom-Json
Write-Output ('re-parse members: ' + $check.members.Count)
$names = @($check.members | ForEach-Object { $_.name })
Write-Output ('unique names: ' + (@($names | Sort-Object -Unique)).Count)
