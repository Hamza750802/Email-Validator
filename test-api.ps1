# ValidR API Test Script
Write-Host "=== ValidR Email Validation API Tests ===" -ForegroundColor Cyan

$baseUrl = "http://localhost:4000"

# Test 1: Health check
Write-Host "`nTest 1: Health Check" -ForegroundColor Yellow
$health = Invoke-RestMethod -Uri "$baseUrl/health" -Method GET
Write-Host "Status: $($health.status)" -ForegroundColor Green
Write-Host "Service: $($health.service)" -ForegroundColor Green

# Test 2: Valid email
Write-Host "`nTest 2: Validate Single Email - Valid" -ForegroundColor Yellow
$body = @{ email = "user@gmail.com"; skipSmtp = $true } | ConvertTo-Json
$result = Invoke-RestMethod -Uri "$baseUrl/validate" -Method POST -Body $body -ContentType "application/json"
Write-Host "Email: $($result.result.email)" -ForegroundColor Green
Write-Host "Score: $($result.result.score)" -ForegroundColor Green

# Test 3: Invalid email
Write-Host "`nTest 3: Validate Single Email - Invalid" -ForegroundColor Yellow
$body = @{ email = "not-an-email" } | ConvertTo-Json
$result = Invoke-RestMethod -Uri "$baseUrl/validate" -Method POST -Body $body -ContentType "application/json"
Write-Host "Score: $($result.result.score)" -ForegroundColor Green

# Test 4: Batch validation
Write-Host "`nTest 4: Validate Batch - 3 emails" -ForegroundColor Yellow
$body = @{ emails = @("user@gmail.com", "admin@example.com", "test@mailinator.com"); skipSmtp = $true } | ConvertTo-Json
$result = Invoke-RestMethod -Uri "$baseUrl/validate-batch" -Method POST -Body $body -ContentType "application/json"
Write-Host "Processed: $($result.results.Count) emails" -ForegroundColor Green
foreach ($r in $result.results) {
    Write-Host "  $($r.email): score=$($r.score)" -ForegroundColor Gray
}

Write-Host "`n=== All Tests Complete ===" -ForegroundColor Cyan
