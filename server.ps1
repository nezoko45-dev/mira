param([int]$Port=8787)
$ErrorActionPreference="Stop"
$Root=(Resolve-Path (Join-Path $PSScriptRoot ".")).Path
$DataDir=Join-Path $env:LOCALAPPDATA "Mira"
$ConfigFile=Join-Path $DataDir "config.json"
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

function Load-Config {
  if(Test-Path $ConfigFile){
    try { return Get-Content $ConfigFile -Raw | ConvertFrom-Json } catch {}
  }
  return [pscustomobject]@{}
}
function Save-Config($c){
  $c | ConvertTo-Json | Set-Content -Path $ConfigFile -Encoding UTF8
}
function Send-Json($ctx,$obj,[int]$status=200){
  $bytes=[Text.Encoding]::UTF8.GetBytes(($obj|ConvertTo-Json -Compress))
  $ctx.Response.StatusCode=$status
  $ctx.Response.ContentType="application/json; charset=utf-8"
  $ctx.Response.ContentLength64=$bytes.Length
  $ctx.Response.OutputStream.Write($bytes,0,$bytes.Length)
  $ctx.Response.Close()
}
function Send-File($ctx,$path){
  if(!(Test-Path $path -PathType Leaf)){ $ctx.Response.StatusCode=404;$ctx.Response.Close();return }
  $ext=[IO.Path]::GetExtension($path).ToLowerInvariant()
  $types=@{".html"="text/html; charset=utf-8";".js"="text/javascript; charset=utf-8";".css"="text/css; charset=utf-8";".png"="image/png";".jpg"="image/jpeg";".jpeg"="image/jpeg";".webp"="image/webp";".ico"="image/x-icon"}
  $ctx.Response.ContentType= if($types.ContainsKey($ext)){$types[$ext]}else{"application/octet-stream"}
  $bytes=[IO.File]::ReadAllBytes($path)
  $ctx.Response.ContentLength64=$bytes.Length
  $ctx.Response.OutputStream.Write($bytes,0,$bytes.Length)
  $ctx.Response.Close()
}

$listener=[Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Host "Mira backend running at http://127.0.0.1:$Port/"
Write-Host "Close this window to stop Mira."

while($listener.IsListening){
  try{$ctx=$listener.GetContext()}catch{break}
  try{
    $path=$ctx.Request.Url.AbsolutePath
    $method=$ctx.Request.HttpMethod

    if($method -eq "GET" -and $path -eq "/api/health"){Send-Json $ctx @{ok=$true};continue}

    if($method -eq "GET" -and $path -eq "/api/config"){
      $c=Load-Config
      Send-Json $ctx @{
        ready=(-not [string]::IsNullOrWhiteSpace([string]$c.deepgramApiKey))
        configured=$true
        backend="batch-powershell"
      }
      continue
    }

    if($method -eq "POST" -and $path -eq "/api/setup"){
      $reader=[IO.StreamReader]::new($ctx.Request.InputStream)
      $body=$reader.ReadToEnd();$reader.Close()
      $incoming=$body|ConvertFrom-Json
      $c=Load-Config
      if($incoming.deepgramApiKey){$c|Add-Member -NotePropertyName deepgramApiKey -NotePropertyValue ([string]$incoming.deepgramApiKey).Trim() -Force}
      Save-Config $c
      Send-Json $ctx @{ok=$true}
      continue
    }

    if($method -eq "GET" -and $path -eq "/api/deepgram-token"){
      $c=Load-Config
      $key=[string]$c.deepgramApiKey
      if([string]::IsNullOrWhiteSpace($key)){Send-Json $ctx @{error="Deepgram API key is missing."} 400;continue}
      try{
        $headers=@{Authorization="Token $key";"Content-Type"="application/json"}
        $grant=Invoke-RestMethod -Uri "https://api.deepgram.com/v1/auth/grant" -Method Post -Headers $headers -Body '{"ttl_seconds":300}'
        $token=[string]$grant.access_token
        if([string]::IsNullOrWhiteSpace($token)){throw "Deepgram did not return a token."}
        $bytes=[Text.Encoding]::UTF8.GetBytes($token)
        $ctx.Response.ContentType="text/plain; charset=utf-8";$ctx.Response.ContentLength64=$bytes.Length
        $ctx.Response.OutputStream.Write($bytes,0,$bytes.Length);$ctx.Response.Close()
      }catch{
        Send-Json $ctx @{error="Deepgram token request failed.";details=$_.Exception.Message} 502
      }
      continue
    }

    if($method -eq "POST" -and $path -eq "/api/video"){
      Send-Json $ctx @{pending=$false;engine="none";message="Video engine disabled. Mira voice mode is active."}
      continue
    }

    if($method -eq "GET" -and $path -eq "/api/mira-image"){
      $img=Join-Path $Root "luna mouth closed.png"
      Send-File $ctx $img
      continue
    }

    $relative=$path.TrimStart("/") -replace "/","\\"
    if([string]::IsNullOrWhiteSpace($relative)){$relative="index.html"}
    $full=[IO.Path]::GetFullPath((Join-Path $Root $relative))
    if(-not $full.StartsWith($Root,[StringComparison]::OrdinalIgnoreCase)){ $ctx.Response.StatusCode=403;$ctx.Response.Close();continue }
    Send-File $ctx $full
  }catch{
    try{Send-Json $ctx @{error=$_.Exception.Message} 500}catch{}
  }
}
$listener.Stop()
