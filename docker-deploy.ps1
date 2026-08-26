#!/usr/bin/env pwsh
# Prison Commerce Docker Deployment Script
# Supports: Build, Deploy, Push to Docker Hub/GHCR

param(
    [Parameter(Position = 0)]
    [ValidateSet("build", "up", "down", "logs", "push-hub", "push-ghcr", "status", "reset")]
    [string]$Command = "status",
    
    [Parameter()]
    [string]$Service = "all",
    
    [Parameter()]
    [string]$DockerHubUsername,
    
    [Parameter()]
    [string]$Version = "latest",
    
    [Parameter()]
    [switch]$NoCache
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DockerDir = Join-Path $ProjectRoot "docker"
$ComposeFile = Join-Path $DockerDir "compose.local.yml"

function Write-Status {
    param([string]$Message, [string]$Status = "info")
    $colors = @{
        "success" = "Green"
        "error"   = "Red"
        "warn"    = "Yellow"
        "info"    = "Cyan"
    }
    $color = $colors[$Status] ?? "White"
    Write-Host "[$Status] $Message" -ForegroundColor $color
}

function Test-DockerInstalled {
    try {
        $null = docker --version
        Write-Status "Docker is installed" "success"
    }
    catch {
        Write-Status "Docker is not installed or not in PATH" "error"
        exit 1
    }
}

function Build-Images {
    param([switch]$NoCache)
    
    Write-Status "Building Docker images..." "info"
    
    $buildArgs = @("compose", "-f", $ComposeFile, "build")
    if ($NoCache) { $buildArgs += "--no-cache" }
    
    try {
        & docker @buildArgs
        Write-Status "Images built successfully" "success"
    }
    catch {
        Write-Status "Build failed: $_" "error"
        exit 1
    }
}

function Start-Services {
    Write-Status "Starting services..." "info"
    
    try {
        & docker compose -f $ComposeFile up -d
        Write-Status "Services started" "success"
        Start-Sleep -Seconds 2
        Get-ServiceStatus
    }
    catch {
        Write-Status "Failed to start services: $_" "error"
        exit 1
    }
}

function Stop-Services {
    Write-Status "Stopping services..." "info"
    
    try {
        & docker compose -f $ComposeFile down
        Write-Status "Services stopped" "success"
    }
    catch {
        Write-Status "Failed to stop services: $_" "error"
        exit 1
    }
}

function Get-ServiceStatus {
    Write-Status "Service Status:" "info"
    
    & docker compose -f $ComposeFile ps
    
    Write-Host ""
    Write-Status "Access points:" "info"
    Write-Host "  LIFF:  http://localhost:5173"
    Write-Host "  Admin: http://localhost:5174"
    Write-Host "  API:   http://localhost:18787"
}

function Show-Logs {
    param([string]$Service)
    
    if ($Service -eq "all") {
        Write-Status "Showing logs for all services..." "info"
        & docker compose -f $ComposeFile logs -f
    }
    else {
        Write-Status "Showing logs for $Service..." "info"
        & docker compose -f $ComposeFile logs -f $Service
    }
}

function Push-ToDockerHub {
    param(
        [string]$Username,
        [string]$Version
    )
    
    if (-not $Username) {
        Write-Status "Docker Hub username required" "error"
        Write-Host "Usage: -Command push-hub -DockerHubUsername <username>"
        exit 1
    }
    
    Write-Status "Logging in to Docker Hub..." "info"
    & docker login docker.io
    
    $images = @("api", "liff", "admin")
    
    foreach ($image in $images) {
        $localImage = "prison-commerce-local-$image`:latest"
        $remoteImage = "$Username/prison-$image`:$Version"
        
        Write-Status "Pushing $image..." "info"
        & docker tag $localImage $remoteImage
        & docker push $remoteImage
        Write-Status "$image pushed to Docker Hub" "success"
    }
    
    Write-Status "All images pushed to Docker Hub!" "success"
}

function Push-ToGHCR {
    param([string]$Username, [string]$Version)
    
    Write-Status "Logging in to GitHub Container Registry..." "info"
    
    $token = Read-Host "Enter GitHub personal access token (with packages scope)"
    
    & docker login ghcr.io -u $Username -p $token
    
    $images = @("api", "liff", "admin")
    
    foreach ($image in $images) {
        $localImage = "prison-commerce-local-$image`:latest"
        $remoteImage = "ghcr.io/$Username/prison-$image`:$Version"
        
        Write-Status "Pushing $image..." "info"
        & docker tag $localImage $remoteImage
        & docker push $remoteImage
        Write-Status "$image pushed to GHCR" "success"
    }
    
    Write-Status "All images pushed to GHCR!" "success"
}

function Reset-Environment {
    Write-Status "Resetting environment..." "warn"
    
    $confirm = Read-Host "This will remove all containers and volumes. Continue? (y/N)"
    if ($confirm -ne "y") {
        Write-Status "Reset cancelled" "info"
        return
    }
    
    Write-Status "Removing containers and volumes..." "info"
    & docker compose -f $ComposeFile down -v
    
    Write-Status "Environment reset" "success"
}

# Main execution
Test-DockerInstalled

Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  Prison Commerce - Docker Deployment Script           ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

switch ($Command) {
    "build" {
        Build-Images -NoCache:$NoCache
    }
    "up" {
        Build-Images -NoCache:$NoCache
        Start-Services
    }
    "down" {
        Stop-Services
    }
    "logs" {
        Show-Logs -Service $Service
    }
    "push-hub" {
        Push-ToDockerHub -Username $DockerHubUsername -Version $Version
    }
    "push-ghcr" {
        Push-ToGHCR -Username $DockerHubUsername -Version $Version
    }
    "status" {
        Get-ServiceStatus
    }
    "reset" {
        Reset-Environment
    }
    default {
        Write-Status "Unknown command: $Command" "error"
        exit 1
    }
}

Write-Host ""
