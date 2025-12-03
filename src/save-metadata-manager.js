const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

/**
 * SaveMetadataManager - Manages metadata for save files including tracking, integrity validation, and statistics
 * Handles checksums, save file tracking, and provides statistics about the save system
 */
class SaveMetadataManager {
  constructor(saveDirectory) {
    this.saveDirectory = saveDirectory;
    this.metadataFile = path.join(saveDirectory, 'metadata.json');
    this.metadata = {
      version: '1.0.0',
      lastSave: null,
      autoSaveEnabled: true,
      autoSaveInterval: 30000, // 30 seconds as per requirements
      backupCount: 10, // Number of backups to keep
      totalSaves: 0,
      migrationCompleted: false,
      saves: {}, // Track individual save files
      statistics: {
        totalSaveOperations: 0,
        totalLoadOperations: 0,
        lastSuccessfulSave: null,
        lastSuccessfulLoad: null,
        averageSaveSize: 0,
        totalDiskUsage: 0
      }
    };
    
    // Load existing metadata on initialization
    this.loadMetadata();
  }

  /**
   * Loads metadata from the metadata file
   * Creates default metadata if file doesn't exist
   */
  async loadMetadata() {
    try {
      await fs.access(this.metadataFile);
      const metadataContent = await fs.readFile(this.metadataFile, 'utf8');
      const loadedMetadata = JSON.parse(metadataContent);
      
      // Merge with defaults to handle version upgrades
      this.metadata = { ...this.metadata, ...loadedMetadata };
      
      // Ensure nested objects exist
      if (!this.metadata.saves) this.metadata.saves = {};
      if (!this.metadata.statistics) {
        this.metadata.statistics = {
          totalSaveOperations: 0,
          totalLoadOperations: 0,
          lastSuccessfulSave: null,
          lastSuccessfulLoad: null,
          averageSaveSize: 0,
          totalDiskUsage: 0
        };
      }
      
      console.log('Metadata loaded successfully');
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('No existing metadata found, creating new metadata file');
        await this.saveMetadata();
      } else if (error instanceof SyntaxError) {
        console.warn('Corrupted metadata file, creating backup and resetting');
        await this.backupCorruptedMetadata();
        await this.saveMetadata();
      } else {
        console.error('Error loading metadata:', error.message);
        throw new Error(`Failed to load metadata: ${error.message}`);
      }
    }
  }

  /**
   * Saves current metadata to the metadata file
   */
  async saveMetadata() {
    try {
      const metadataJson = JSON.stringify(this.metadata, null, 2);
      const tempFile = `${this.metadataFile}.tmp`;
      
      // Write to temporary file first, then rename for atomic operation
      await fs.writeFile(tempFile, metadataJson, 'utf8');
      await fs.rename(tempFile, this.metadataFile);
      
      console.log('Metadata saved successfully');
    } catch (error) {
      throw new Error(`Failed to save metadata: ${error.message}`);
    }
  }

  /**
   * Backs up corrupted metadata file for debugging
   */
  async backupCorruptedMetadata() {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFile = path.join(this.saveDirectory, `metadata_corrupted_${timestamp}.json`);
      await fs.copyFile(this.metadataFile, backupFile);
      console.log(`Corrupted metadata backed up to: ${backupFile}`);
    } catch (error) {
      console.warn('Could not backup corrupted metadata:', error.message);
    }
  }
 
  /**
   * Registers a new save file in the metadata tracking system
   * @param {string} filename - Name of the save file
   * @param {Object} saveInfo - Information about the save operation
   */
  async registerSaveFile(filename, saveInfo) {
    try {
      const timestamp = Date.now();
      
      // Calculate checksum for the save file
      const filePath = path.join(this.saveDirectory, filename);
      const fileContent = await fs.readFile(filePath);
      const checksum = this.calculateChecksum(fileContent);
      
      // Register save file in metadata
      this.metadata.saves[filename] = {
        filename: filename,
        checksum: checksum,
        size: saveInfo.size || fileContent.length,
        created: timestamp,
        lastModified: timestamp,
        isBackup: filename.includes('backup_'),
        saveCount: (this.metadata.saves[filename]?.saveCount || 0) + 1,
        gameVersion: saveInfo.gameVersion || 'unknown',
        playerLevel: saveInfo.playerLevel || 0
      };

      // Update global metadata
      this.metadata.lastSave = timestamp;
      this.metadata.totalSaves++;
      this.metadata.statistics.totalSaveOperations++;
      this.metadata.statistics.lastSuccessfulSave = timestamp;
      
      // Update average save size
      await this.updateStatistics();
      
      // Save metadata
      await this.saveMetadata();
      
      console.log(`Save file registered: ${filename}`);
      return this.metadata.saves[filename];
    } catch (error) {
      throw new Error(`Failed to register save file ${filename}: ${error.message}`);
    }
  }

  /**
   * Validates the integrity of a save file using checksums
   * @param {string} filename - Name of the file to validate
   * @returns {Promise<Object>} Validation result
   */
  async validateSaveFileIntegrity(filename) {
    try {
      const filePath = path.join(this.saveDirectory, filename);
      
      // Check if file exists
      await fs.access(filePath);
      
      // Get stored metadata for this file
      const storedMetadata = this.metadata.saves[filename];
      if (!storedMetadata) {
        return {
          valid: false,
          reason: 'No metadata found for file',
          filename: filename
        };
      }

      // Calculate current checksum
      const fileContent = await fs.readFile(filePath);
      const currentChecksum = this.calculateChecksum(fileContent);
      
      // Compare checksums
      const isValid = currentChecksum === storedMetadata.checksum;
      
      return {
        valid: isValid,
        filename: filename,
        storedChecksum: storedMetadata.checksum,
        currentChecksum: currentChecksum,
        reason: isValid ? 'File integrity verified' : 'Checksum mismatch - file may be corrupted',
        fileSize: fileContent.length,
        lastModified: storedMetadata.lastModified
      };
    } catch (error) {
      return {
        valid: false,
        filename: filename,
        reason: `Validation error: ${error.message}`,
        error: error.message
      };
    }
  }

  /**
   * Validates integrity of all tracked save files
   * @returns {Promise<Object>} Validation results for all files
   */
  async validateAllSaveFiles() {
    const results = {
      totalFiles: 0,
      validFiles: 0,
      invalidFiles: 0,
      missingFiles: 0,
      details: []
    };

    try {
      for (const filename of Object.keys(this.metadata.saves)) {
        const validation = await this.validateSaveFileIntegrity(filename);
        results.details.push(validation);
        results.totalFiles++;
        
        if (validation.valid) {
          results.validFiles++;
        } else {
          results.invalidFiles++;
          if (validation.reason.includes('ENOENT') || validation.reason.includes('not found')) {
            results.missingFiles++;
          }
        }
      }
      
      console.log(`Validation complete: ${results.validFiles}/${results.totalFiles} files valid`);
      return results;
    } catch (error) {
      throw new Error(`Failed to validate save files: ${error.message}`);
    }
  }

  /**
   * Records a load operation in the metadata
   * @param {string} filename - Name of the loaded file
   */
  async recordLoadOperation(filename) {
    try {
      const timestamp = Date.now();
      
      // Update file-specific metadata
      if (this.metadata.saves[filename]) {
        this.metadata.saves[filename].lastAccessed = timestamp;
      }
      
      // Update global statistics
      this.metadata.statistics.totalLoadOperations++;
      this.metadata.statistics.lastSuccessfulLoad = timestamp;
      
      await this.saveMetadata();
      console.log(`Load operation recorded for: ${filename}`);
    } catch (error) {
      console.error(`Failed to record load operation: ${error.message}`);
    }
  }

  /**
   * Removes a save file from metadata tracking
   * @param {string} filename - Name of the file to unregister
   */
  async unregisterSaveFile(filename) {
    try {
      if (this.metadata.saves[filename]) {
        delete this.metadata.saves[filename];
        await this.saveMetadata();
        console.log(`Save file unregistered: ${filename}`);
      }
    } catch (error) {
      console.error(`Failed to unregister save file ${filename}: ${error.message}`);
    }
  }

  /**
   * Updates statistics based on current save files
   */
  async updateStatistics() {
    try {
      const saveFiles = Object.values(this.metadata.saves);
      
      if (saveFiles.length > 0) {
        const totalSize = saveFiles.reduce((sum, file) => sum + (file.size || 0), 0);
        this.metadata.statistics.averageSaveSize = Math.round(totalSize / saveFiles.length);
        this.metadata.statistics.totalDiskUsage = totalSize;
      } else {
        this.metadata.statistics.averageSaveSize = 0;
        this.metadata.statistics.totalDiskUsage = 0;
      }
      
      console.log('Statistics updated');
    } catch (error) {
      console.error('Failed to update statistics:', error.message);
    }
  }

  /**
   * Gets comprehensive statistics about the save system
   * @returns {Object} Save system statistics
   */
  getStatistics() {
    const saveFiles = Object.values(this.metadata.saves);
    const backupFiles = saveFiles.filter(file => file.isBackup);
    const regularFiles = saveFiles.filter(file => !file.isBackup);
    
    return {
      ...this.metadata.statistics,
      totalFiles: saveFiles.length,
      backupFiles: backupFiles.length,
      regularFiles: regularFiles.length,
      oldestSave: saveFiles.length > 0 ? Math.min(...saveFiles.map(f => f.created)) : null,
      newestSave: saveFiles.length > 0 ? Math.max(...saveFiles.map(f => f.created)) : null,
      autoSaveEnabled: this.metadata.autoSaveEnabled,
      autoSaveInterval: this.metadata.autoSaveInterval,
      migrationCompleted: this.metadata.migrationCompleted
    };
  }

  /**
   * Gets metadata for a specific save file
   * @param {string} filename - Name of the file
   * @returns {Object|null} File metadata or null if not found
   */
  getSaveFileMetadata(filename) {
    return this.metadata.saves[filename] || null;
  }

  /**
   * Gets list of all tracked save files with their metadata
   * @returns {Array} Array of save file metadata
   */
  getAllSaveFiles() {
    return Object.values(this.metadata.saves).sort((a, b) => b.lastModified - a.lastModified);
  }

  /**
   * Updates configuration settings
   * @param {Object} config - Configuration updates
   */
  async updateConfiguration(config) {
    try {
      if (config.autoSaveEnabled !== undefined) {
        this.metadata.autoSaveEnabled = config.autoSaveEnabled;
      }
      if (config.autoSaveInterval !== undefined) {
        this.metadata.autoSaveInterval = config.autoSaveInterval;
      }
      if (config.backupCount !== undefined) {
        this.metadata.backupCount = config.backupCount;
      }
      if (config.migrationCompleted !== undefined) {
        this.metadata.migrationCompleted = config.migrationCompleted;
      }
      
      await this.saveMetadata();
      console.log('Configuration updated');
    } catch (error) {
      throw new Error(`Failed to update configuration: ${error.message}`);
    }
  }

  /**
   * Cleans up metadata for files that no longer exist
   */
  async cleanupOrphanedMetadata() {
    try {
      const existingFiles = await fs.readdir(this.saveDirectory);
      const trackedFiles = Object.keys(this.metadata.saves);
      let cleanedCount = 0;
      
      for (const filename of trackedFiles) {
        if (!existingFiles.includes(filename)) {
          delete this.metadata.saves[filename];
          cleanedCount++;
        }
      }
      
      if (cleanedCount > 0) {
        await this.updateStatistics();
        await this.saveMetadata();
        console.log(`Cleaned up ${cleanedCount} orphaned metadata entries`);
      }
      
      return cleanedCount;
    } catch (error) {
      console.error('Failed to cleanup orphaned metadata:', error.message);
      return 0;
    }
  }

  /**
   * Calculates SHA-256 checksum for data integrity validation
   * @param {Buffer} data - Data to calculate checksum for
   * @returns {string} Hexadecimal checksum
   */
  calculateChecksum(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Gets the current metadata object (read-only copy)
   * @returns {Object} Current metadata
   */
  getMetadata() {
    return JSON.parse(JSON.stringify(this.metadata)); // Deep clone for read-only access
  }

  /**
   * Exports metadata to a backup file
   * @param {string} backupPath - Path for the backup file
   */
  async exportMetadata(backupPath) {
    try {
      const metadataJson = JSON.stringify(this.metadata, null, 2);
      await fs.writeFile(backupPath, metadataJson, 'utf8');
      console.log(`Metadata exported to: ${backupPath}`);
    } catch (error) {
      throw new Error(`Failed to export metadata: ${error.message}`);
    }
  }
}

module.exports = SaveMetadataManager;
