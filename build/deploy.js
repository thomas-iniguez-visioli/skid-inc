#!/usr/bin/env node

/**
 * Deployment Script for Skid-Inc
 * Handles deployment to various platforms and services
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class DeploymentManager {
  constructor() {
    this.config = this.loadConfig();
    this.deployLog = [];
  }

  loadConfig() {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    return {
      version: packageJson.version,
      appName: packageJson.build.productName,
      repository: packageJson.repository,
      outputDir: 'dist',
      deploymentTargets: process.env.DEPLOY_TARGETS ? process.env.DEPLOY_TARGETS.split(',') : ['github'],
      isDryRun: process.env.DRY_RUN === 'true'
    };
  }

  log(message, level = 'info') {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    console.log(logEntry);
    this.deployLog.push(logEntry);
  }

  async executeCommand(command, args = [], options = {}) {
    this.log(`Executing: ${command} ${args.map(a => JSON.stringify(a)).join(' ')}`);
    try {
      const result = execFileSync(command, args, {
        encoding: 'utf8',
        stdio: 'pipe',
        ...options
      });
      return result;
    } catch (error) {
      this.log(`Command failed: ${error.message}`, 'error');
      throw error;
    }
  }

  async validateDeploymentEnvironment() {
    this.log('Validating deployment environment...');

    // Check if dist directory exists
    if (!fs.existsSync(this.config.outputDir)) {
      throw new Error(`Output directory ${this.config.outputDir} not found. Run build first.`);
    }

    // Check for artifacts
    const artifacts = this.getArtifacts();
    if (artifacts.length === 0) {
      throw new Error('No build artifacts found. Run build first.');
    }

    this.log(`Found ${artifacts.length} artifacts for deployment`);

    // Validate Git repository
    try {
      await this.executeCommand('git status --porcelain');
      const currentBranch = await this.executeCommand('git branch --show-current');
      this.log(`Current branch: ${currentBranch.trim()}`);
    } catch (error) {
      throw new Error('Not in a Git repository or Git not available');
    }

    // Check for required environment variables
    this.validateEnvironmentVariables();
  }

  validateEnvironmentVariables() {
    const requiredVars = [];
    
    if (this.config.deploymentTargets.includes('github')) {
      if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
        requiredVars.push('GITHUB_TOKEN or GH_TOKEN');
      }
    }

    if (this.config.deploymentTargets.includes('s3')) {
      if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
        requiredVars.push('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY');
      }
    }

    if (requiredVars.length > 0) {
      throw new Error(`Missing required environment variables: ${requiredVars.join(', ')}`);
    }
  }

  getArtifacts() {
    const artifacts = [];
    const distFiles = fs.readdirSync(this.config.outputDir);
    
    for (const file of distFiles) {
      const filePath = path.join(this.config.outputDir, file);
      const stats = fs.statSync(filePath);
      
      if (stats.isFile() && this.isDeployableArtifact(file)) {
        artifacts.push({
          name: file,
          path: filePath,
          size: stats.size,
          checksum: this.calculateChecksum(filePath)
        });
      }
    }
    
    return artifacts;
  }

  isDeployableArtifact(filename) {
    const deployableExtensions = ['.exe', '.dmg', '.zip', '.AppImage', '.deb', '.rpm', '.tar.gz'];
    return deployableExtensions.some(ext => filename.endsWith(ext));
  }

  calculateChecksum(filePath) {
    const fileBuffer = fs.readFileSync(filePath);
    const hashSum = crypto.createHash('sha256');
    hashSum.update(fileBuffer);
    return hashSum.digest('hex');
  }

  async createReleaseNotes() {
    this.log('Generating release notes...');
    
    try {
      // Get commits since last tag
      const lastTag = await this.executeCommand('git describe --tags --abbrev=0 HEAD~1').catch(() => '');
      const commitRange = lastTag.trim() ? `${lastTag.trim()}..HEAD` : 'HEAD';
      const commits = await this.executeCommand(`git log ${commitRange} --pretty=format:"- %s (%h)"`);
      
      const releaseNotes = `# Release v${this.config.version}

## Changes

${commits.trim() || '- Initial release'}

## Downloads

The following files are available for download:

${this.getArtifacts().map(artifact => 
  `- **${artifact.name}** (${this.formatFileSize(artifact.size)}) - SHA256: \`${artifact.checksum}\``
).join('\n')}

## Installation

### Windows
Download and run the \`.exe\` installer or use the portable version.

### macOS
Download the \`.dmg\` file and drag the app to your Applications folder.

### Linux
- **AppImage**: Download and make executable, then run directly
- **DEB**: Install with \`sudo dpkg -i filename.deb\`
- **RPM**: Install with \`sudo rpm -i filename.rpm\`

## System Requirements

- **Windows**: Windows 10 or later (64-bit)
- **macOS**: macOS 10.14 or later
- **Linux**: Most modern distributions (64-bit)

---

*Built on ${new Date().toISOString().split('T')[0]}*
`;

      const notesPath = path.join(this.config.outputDir, 'RELEASE_NOTES.md');
      fs.writeFileSync(notesPath, releaseNotes);
      this.log(`Release notes saved to: ${notesPath}`);
      
      return releaseNotes;
    } catch (error) {
      this.log(`Failed to generate release notes: ${error.message}`, 'warn');
      return `# Release v${this.config.version}\n\nNew release of ${this.config.appName}`;
    }
  }

  async deployToGitHub() {
    this.log('Deploying to GitHub Releases...');
    
    if (this.config.isDryRun) {
      this.log('DRY RUN: Would deploy to GitHub', 'warn');
      return;
    }

    try {
      // Check if gh CLI is available
      await this.executeCommand('gh --version');
    } catch (error) {
      throw new Error('GitHub CLI (gh) not found. Please install it first.');
    }

    const releaseNotes = await this.createReleaseNotes();
    const artifacts = this.getArtifacts();
    
    // Create release
    const tagName = `v${this.config.version}`;
    const releaseTitle = `${this.config.appName} v${this.config.version}`;
    
    try {
      // Create the release
      await this.executeCommand(`gh release create "${tagName}" --title "${releaseTitle}" --notes-file "${path.join(this.config.outputDir, 'RELEASE_NOTES.md')}"`);
      this.log(`Created GitHub release: ${tagName}`);
      
      // Upload artifacts
      for (const artifact of artifacts) {
        this.log(`Uploading ${artifact.name}...`);
        await this.executeCommand(`gh release upload "${tagName}" "${artifact.path}"`);
        this.log(`Uploaded ${artifact.name}`);
      }
      
      this.log('GitHub deployment completed successfully');
    } catch (error) {
      if (error.message.includes('already exists')) {
        this.log('Release already exists, uploading additional assets...', 'warn');
        
        // Upload missing artifacts
        for (const artifact of artifacts) {
          try {
            await this.executeCommand(`gh release upload "${tagName}" "${artifact.path}"`);
            this.log(`Uploaded ${artifact.name}`);
          } catch (uploadError) {
            if (uploadError.message.includes('already exists')) {
              this.log(`${artifact.name} already uploaded`, 'warn');
            } else {
              throw uploadError;
            }
          }
        }
      } else {
        throw error;
      }
    }
  }

  async deployToS3() {
    this.log('Deploying to Amazon S3...');
    
    if (this.config.isDryRun) {
      this.log('DRY RUN: Would deploy to S3', 'warn');
      return;
    }

    const bucketName = process.env.S3_BUCKET_NAME;
    const bucketPrefix = process.env.S3_BUCKET_PREFIX || 'releases';
    
    if (!bucketName) {
      throw new Error('S3_BUCKET_NAME environment variable not set');
    }

    try {
      // Check if AWS CLI is available
      await this.executeCommand('aws', ['--version']);
    } catch (error) {
      throw new Error('AWS CLI not found. Please install it first.');
    }

    const artifacts = this.getArtifacts();
    
    for (const artifact of artifacts) {
      const s3Key = `${bucketPrefix}/v${this.config.version}/${artifact.name}`;
      this.log(`Uploading ${artifact.name} to s3://${bucketName}/${s3Key}...`);
      
      await this.executeCommand(
        'aws',
        [
          's3',
          'cp',
          artifact.path,
          `s3://${bucketName}/${s3Key}`,
          '--metadata',
          `version=${this.config.version},checksum=${artifact.checksum}`
        ]
      );
      this.log(`Uploaded ${artifact.name} to S3`);
    }
    
    // Upload release notes
    const notesPath = path.join(this.config.outputDir, 'RELEASE_NOTES.md');
    if (fs.existsSync(notesPath)) {
      const notesS3Key = `${bucketPrefix}/v${this.config.version}/RELEASE_NOTES.md`;
      await this.executeCommand(
        'aws',
        [
          's3',
          'cp',
          notesPath,
          `s3://${bucketName}/${notesS3Key}`
        ]
      );
      this.log('Uploaded release notes to S3');
    }
    
    this.log('S3 deployment completed successfully');
  }

  async createChecksumFile() {
    this.log('Creating checksum file...');
    
    const artifacts = this.getArtifacts();
    const checksums = artifacts.map(artifact => 
      `${artifact.checksum}  ${artifact.name}`
    ).join('\n');
    
    const checksumPath = path.join(this.config.outputDir, 'SHA256SUMS');
    fs.writeFileSync(checksumPath, checksums + '\n');
    
    this.log(`Checksum file created: ${checksumPath}`);
    return checksumPath;
  }

  formatFileSize(bytes) {
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 Bytes';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  }

  async generateDeploymentReport() {
    const artifacts = this.getArtifacts();
    const report = {
      timestamp: new Date().toISOString(),
      version: this.config.version,
      appName: this.config.appName,
      deploymentTargets: this.config.deploymentTargets,
      isDryRun: this.config.isDryRun,
      artifacts: artifacts,
      totalSize: artifacts.reduce((sum, artifact) => sum + artifact.size, 0),
      deployLog: this.deployLog
    };

    const reportPath = path.join(this.config.outputDir, 'deployment-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    
    this.log(`Deployment report saved to: ${reportPath}`);
    return report;
  }

  async run() {
    try {
      this.log(`Starting deployment for ${this.config.appName} v${this.config.version}`);
      
      if (this.config.isDryRun) {
        this.log('Running in DRY RUN mode - no actual deployment will occur', 'warn');
      }

      await this.validateDeploymentEnvironment();
      await this.createChecksumFile();
      
      // Deploy to each target
      for (const target of this.config.deploymentTargets) {
        switch (target) {
          case 'github':
            await this.deployToGitHub();
            break;
          case 's3':
            await this.deployToS3();
            break;
          default:
            this.log(`Unknown deployment target: ${target}`, 'warn');
        }
      }
      
      const report = await this.generateDeploymentReport();
      
      console.log('\n' + '='.repeat(60));
      console.log('DEPLOYMENT SUMMARY');
      console.log('='.repeat(60));
      console.log(`App: ${report.appName} v${report.version}`);
      console.log(`Targets: ${report.deploymentTargets.join(', ')}`);
      console.log(`Artifacts: ${report.artifacts.length}`);
      console.log(`Total Size: ${this.formatFileSize(report.totalSize)}`);
      console.log(`Dry Run: ${report.isDryRun ? 'Yes' : 'No'}`);
      console.log('='.repeat(60));
      
      this.log('Deployment completed successfully!');
      
    } catch (error) {
      this.log(`Deployment failed: ${error.message}`, 'error');
      
      console.error('\n' + '='.repeat(60));
      console.error('DEPLOYMENT FAILED');
      console.error('='.repeat(60));
      console.error(`Error: ${error.message}`);
      console.error('='.repeat(60));
      
      process.exit(1);
    }
  }
}

// Run if called directly
if (require.main === module) {
  const deployer = new DeploymentManager();
  deployer.run();
}

module.exports = DeploymentManager;