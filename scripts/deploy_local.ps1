# Deploy per-flavor MarketSyncData builds to matching local World of Warcraft installations
param (
    [string]$Product = "_forever_"
)

$wowRoot = "C:\Program Files (x86)\World of Warcraft"
$productFlavorMap = @{
    "_anniversary_"     = "Anniversary"
    "_classic_"         = "Classic"
    "_classic_beta_"    = "Classic"
    "_classic_era_"     = "ClassicEra"
    "_classic_era_ptr_" = "ClassicEra"
    "_forever_"         = "Forever"
    "_retail_"          = "Retail"
}

$products = if ($Product -eq "all") {
    @('_anniversary_', '_classic_', '_classic_beta_', '_classic_era_', '_classic_era_ptr_', '_forever_', '_retail_')
} else {
    @($Product)
}

Write-Host "Compiling fresh 90-day per-flavor MarketSyncData builds..."
node "$PSScriptRoot\compile.js"
if ($LASTEXITCODE -ne 0) {
    throw "Failed to compile per-flavor MarketSyncData builds."
}

$buildsRoot = "$PSScriptRoot\..\dist\builds"

foreach ($p in $products) {
    $flavorLabel = $productFlavorMap[$p]
    if (-not $flavorLabel) {
        Write-Warning "Unknown product '$p'; skipping."
        continue
    }

    $source = "$buildsRoot\$flavorLabel\MarketSyncData"
    if (-not (Test-Path $source)) {
        Write-Warning "Compiled build missing for $flavorLabel ($source); skipping $p."
        continue
    }

    $targetDir = "$wowRoot\$p\Interface\AddOns\MarketSyncData"
    if (Test-Path "$wowRoot\$p\Interface\AddOns") {
        Write-Host "Deploying MarketSyncData ($flavorLabel) to $p..."
        if (-not (Test-Path $targetDir)) {
            New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
        }
        Copy-Item -Path "$source\*" -Destination $targetDir -Recurse -Force
        Write-Host "  -> Deployed $flavorLabel build successfully to $targetDir"

        # Forever packs are separate LoadOnDemand addons. Drop the old single-file pack if it is still there.
        if ($flavorLabel -eq "Forever") {
            Remove-Item -Path "$targetDir\MarketSyncData.lua" -Force -ErrorAction SilentlyContinue
            $packSource = "$buildsRoot\$flavorLabel\packs"
            if (Test-Path $packSource) {
                Get-ChildItem -Path $packSource -Directory | ForEach-Object {
                    $packTarget = "$wowRoot\$p\Interface\AddOns\$($_.Name)"
                    if (-not (Test-Path $packTarget)) {
                        New-Item -ItemType Directory -Path $packTarget -Force | Out-Null
                    }
                    Copy-Item -Path "$($_.FullName)\*" -Destination $packTarget -Recurse -Force
                    Write-Host "  -> Deployed pack $($_.Name)"
                }
            }
        }
    }
}
