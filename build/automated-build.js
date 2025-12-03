#!/usr/bin/env node

/**
 * Automated Build Script for Skid-Inc
 * Handles complete build pipeline with error handling and notifications
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

class AutomatedBuilder {
  constructor() {
    this.startTime = Date.now();
    this.buildLog = [];
    this.config = this.loadConfig();
  }

  loadConfig() {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    return {
      version: packageJson.version,
      appName: packageJson.build.productName,
      platforms: process.env.BUILD_PLATFORMS ? process.env.BUILD_PLATFORMS.split(',') : ['current'],
      outputDir: 'dist',
      logFile: `build-${Date.now()}.log`,
      skipSigning: process.env.NODE_ENV === 'development' || process.env.SKIP_SIGNING === 'true'
    };
  }

  log(message, level = 'info') {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    console.log(logEntry);
    this.buildLog.push(logEntry);
  }

  executeCommand(command, options = {}) {
    this.log(`Executing: "${command}"`);
    try {
      const execOptions = { 
        encoding: 'utf8', 
        stdio: options.captureOutput ? 'pipe' : 'inherit',
        maxBuffer: 1024 * 1024 * 10, // 10MB buffer
        shell: true, // Important for cross-platform compatibility
        cwd: process.cwd() // Ensure working directory is set
      };

      // Remove the captureOutput option from execOptions to avoid passing it to execSync
      const { captureOutput, ...restOptions } = options;
      Object.assign(execOptions, restOptions);
      
      const result = execSync(command, execOptions);
      
      if (options.captureOutput) {
        // Log each line of output
        const lines = result.split('\n').filter(line => line.trim());
        lines.forEach(line => this.log(`OUTPUT: ${line}`));
        return result;
      }
      
      return result;
    } catch (error) {
      // Capture error output
      let errorOutput = '';
      if (error.stdout) {
        errorOutput += `STDOUT:\n${error.stdout}\n`;
      }
      if (error.stderr) {
        errorOutput += `STDERR:\n${error.stderr}\n`;
      }
      if (error.message) {
        errorOutput += `ERROR: ${error.message}`;
      }
      
      this.log(`Command failed: ${errorOutput}`, 'error');
      throw new Error(`Command failed: ${command}`);
    }
  }

  async validateEnvironment() {
    this.log('Validating build environment...');
    
    // Check Node.js version
    const nodeVersion = process.version;
    this.log(`Node.js version: ${nodeVersion}`);
    
    // Check npm version
    try {
      const npmVersion = this.executeCommand('npm --version', { captureOutput: true });
      this.log(`npm version: ${npmVersion.trim()}`);
    } catch (error) {
      throw new Error('npm not found. Please install Node.js and npm.');
    }

    // Check electron-builder
    try {
      this.executeCommand('npx electron-builder --version', { captureOutput: true });
      this.log('electron-builder is available');
    } catch (error) {
      throw new Error('electron-builder not found. Run npm install first.');
    }

    // Check Git (for build metadata)
    try {
      const gitVersion = this.executeCommand('git --version', { captureOutput: true });
      this.log(`Git version: ${gitVersion.trim()}`);
    } catch (error) {
      this.log('Git not found - build metadata will be limited', 'warn');
    }

    // Validate code signing setup
    if (!this.config.skipSigning) {
      this.validateCodeSigning();
    } else {
      this.log('Code signing skipped (development mode)', 'warn');
    }
  }

  validateCodeSigning() {
    const platform = os.platform();
    
    if (platform === 'win32') {
      if (!process.env.WIN_CSC_LINK) {
        this.log('Windows code signing not configured (WIN_CSC_LINK missing)', 'warn');
      } else {
        this.log('Windows code signing configured');
      }
    } else if (platform === 'darwin') {
      if (!process.env.CSC_NAME && !process.env.CSC_LINK) {
        this.log('macOS code signing not configured', 'warn');
      } else {
        this.log('macOS code signing configured');
      }
    }
  }

  async cleanPreviousBuilds() {
    this.log('Cleaning previous builds...');
    
    if (fs.existsSync(this.config.outputDir)) {
      fs.rmSync(this.config.outputDir, { recursive: true, force: true });
      this.log(`Cleaned ${this.config.outputDir} directory`);
    }

    // Clean node_modules/.cache if it exists
    const cacheDir = path.join('node_modules', '.cache');
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      this.log('Cleaned electron-builder cache');
    }
  }

  async installDependencies() {
    this.log('Installing/updating dependencies...');
    this.executeCommand('npm ci');
    this.log('Dependencies installed successfully');
  }

  async runPreBuild() {
    this.log('Running pre-build tasks...');
    this.executeCommand('npm run prebuild');
    this.log('Pre-build tasks completed');
  }

  async buildForPlatforms() {
    const platforms = this.config.platforms;
    
    for (const platform of platforms) {
      await this.buildForPlatform(platform);
    }
  }

  async buildForPlatform(platform) {
    this.log(`Building for platform: ${platform}`);
    
    let buildCommand;
    switch (platform) {
      case 'win':
      case 'windows':
        buildCommand = 'npm run build:win';
        break;
      case 'mac':
      case 'macos':
      case 'darwin':
        buildCommand = 'npm run build:mac';
        break;
      case 'linux':
        buildCommand = 'npm run build:linux';
        break;
      case 'all':
        buildCommand = 'npm run build:all';
        break;
      case 'current':
      default:
        buildCommand = 'npm run build';
        break;
    }

    const buildStart = Date.now();
    try {
      // Capture full console output during build
      this.executeCommand(buildCommand, { captureOutput: true });
      const buildTime = Date.now() - buildStart;
      
      this.log(`Platform ${platform} built successfully in ${Math.round(buildTime / 1000)}s`);
    } catch (error) {
      const buildTime = Date.now() - buildStart;
      this.log(`Platform ${platform} build failed after ${Math.round(buildTime / 1000)}s`, 'error');
      
      // Generate error report with full context
      const errorReport = {
        timestamp: new Date().toISOString(),
        version: this.config.version,
        platform,
        command: buildCommand,
        buildTimeMs: buildTime,
        error: error.message,
        buildLog: this.buildLog,
        systemInfo: {
          nodeVersion: process.version,
          platform: os.platform(),
          arch: os.arch(),
          totalMemory: os.totalmem(),
          freeMemory: os.freemem()
        }
      };
      
      // Save error report
      const errorDir = path.join(this.config.outputDir, 'build-errors');
      if (!fs.existsSync(errorDir)) {
        fs.mkdirSync(errorDir, { recursive: true });
      }
      
      const errorFile = path.join(errorDir, `error-${Date.now()}.json`);
      fs.writeFileSync(errorFile, JSON.stringify(errorReport, null, 2));
      
      this.log(`Error report saved to: ${errorFile}`, 'error');
      throw error;
    }
  }

  async generateBuildReport() {
    this.log('Generating build report...');
    
    const buildTime = Date.now() - this.startTime;
    const report = {
      timestamp: new Date().toISOString(),
      version: this.config.version,
      appName: this.config.appName,
      platforms: this.config.platforms,
      buildTimeMs: buildTime,
      buildTimeSec: Math.round(buildTime / 1000),
      success: true,
      artifacts: []
    };

    // Scan output directory for artifacts
    if (fs.existsSync(this.config.outputDir)) {
      const files = fs.readdirSync(this.config.outputDir);
      for (const file of files) {
        const filePath = path.join(this.config.outputDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.isFile()) {
          report.artifacts.push({
            name: file,
            size: stats.size,
            sizeHuman: this.formatFileSize(stats.size),
            path: filePath
          });
        }
      }
    }

    // Write report
    const reportPath = path.join(this.config.outputDir, 'build-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    
    // Write build log
    const logPath = path.join(this.config.outputDir, this.config.logFile);
    fs.writeFileSync(logPath, this.buildLog.join('\n'));

    this.log(`Build report saved to: ${reportPath}`);
    this.log(`Build log saved to: ${logPath}`);
    
    return report;
  }

  formatFileSize(bytes) {
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 Bytes';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  }

  async printSummary(report) {
    console.log('\n' + '='.repeat(60));
    console.log('BUILD SUMMARY');
    console.log('='.repeat(60));
    console.log(`App: ${report.appName} v${report.version}`);
    console.log(`Platforms: ${report.platforms.join(', ')}`);
    console.log(`Build Time: ${report.buildTimeSec}s`);
    console.log(`Artifacts: ${report.artifacts.length}`);
    
    if (report.artifacts.length > 0) {
      console.log('\nGenerated Files:');
      for (const artifact of report.artifacts) {
        console.log(`  - ${artifact.name} (${artifact.sizeHuman})`);
      }
    }
    
    console.log(`\nOutput Directory: ${this.config.outputDir}`);
    console.log('='.repeat(60));
  }

  async run() {
    try {
      this.log(`Starting automated build for ${this.config.appName} v${this.config.version}`);
      
      await this.validateEnvironment();
      await this.cleanPreviousBuilds();
      await this.installDependencies();
      await this.runPreBuild();
      await this.buildForPlatforms();
      
      const report = await this.generateBuildReport();
      await this.printSummary(report);
      
      this.log('Automated build completed successfully!');
      process.exit(0);
      
    } catch (error) {
      this.log(`Build failed: ${error.message}`, 'error');
      
      // Generate error report
      const errorReport = {
        timestamp: new Date().toISOString(),
        version: this.config.version,
        error: error.message,
        stack: error.stack,
        buildLog: this.buildLog
      };
      
      fs.mkdirSync('build-errors', { recursive: true });
      const errorPath = path.join('build-errors', `error-${Date.now()}.json`);
      fs.writeFileSync(errorPath, JSON.stringify(errorReport, null, 2));
      
      console.error('\n' + '='.repeat(60));
      console.error('BUILD FAILED');
      console.error('='.repeat(60));
      console.error(`Error: ${error.message}`);
      console.error(`Error report saved to: ${errorPath}`);
      console.error('='.repeat(60));
      
      process.exit(1);
    }
  }
}

// Run if called directly
if (require.main === module) {
  const builder = new AutomatedBuilder();
  builder.run();
}

module.exports = AutomatedBuilder;