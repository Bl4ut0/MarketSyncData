# Deploy MarketSyncData to local World of Warcraft installations
param (
    [string]$Product = "_forever_"
)

$wowRoot = "C:\Program Files (x86)\World of Warcraft"
$products = if ($Product -eq "all") {
    @('_anniversary_', '_classic_', '_classic_beta_', '_classic_era_', '_classic_era_ptr_', '_forever_', '_retail_')
} else {
    @($Product)
}

$source = "$PSScriptRoot\..\MarketSyncData"

foreach ($p in $products) {
    $targetDir = "$wowRoot\$p\Interface\AddOns\MarketSyncData"
    if (Test-Path "$wowRoot\$p\Interface\AddOns") {
        Write-Host "Deploying MarketSyncData to $p..."
        if (-not (Test-Path $targetDir)) {
            New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
        }
        Copy-Item -Path "$source\*" -Destination $targetDir -Recurse -Force
        Write-Host "  -> Deployed successfully to $targetDir"
    }
}
