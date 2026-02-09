#!/usr/bin/env node
/**
 * TFS 配置管理工具 - 增强版
 * 卫宁健康 WINNING-6.0 团队
 * 
 * 支持功能：
 * - 交互式配置向导
 * - 验证配置有效性
 * - 查看当前配置
 * - 重置配置
 * 
 * 使用方法:
 *   node setup-config.mjs                    # 交互式配置
 *   node setup-config.mjs <pat> [username]   # 快速配置
 *   node setup-config.mjs --check            # 验证配置
 *   node setup-config.mjs --show             # 显示当前配置
 *   node setup-config.mjs --reset            # 重置配置
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'tfs-config.json');
const DEFAULT_SERVER_URL = 'http://tfs2018-web.winning.com.cn:8080/tfs/WINNING-6.0';

// ANSI 颜色
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m'
};

function print(color, message) {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function printHeader(title) {
  console.log();
  print('cyan', '═══════════════════════════════════════════════════════════');
  print('bright', `  ${title}`);
  print('cyan', '═══════════════════════════════════════════════════════════');
  console.log();
}

function printSuccess(message) {
  print('green', `✓ ${message}`);
}

function printError(message) {
  print('red', `✗ ${message}`);
}

function printWarning(message) {
  print('yellow', `⚠ ${message}`);
}

function printInfo(message) {
  print('blue', `ℹ ${message}`);
}

/**
 * 提问函数（ESM 版本）
 */
function askQuestion(question) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * 保存配置
 */
function saveConfigFile(config) {
  const configDir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * 加载配置
 */
function loadConfigFile() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return null;
  }
  const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
  return JSON.parse(content);
}

/**
 * 显示帮助信息
 */
function showHelp() {
  printHeader('TFS Configuration Manager');
  
  console.log('Usage:');
  console.log('  node setup-config.mjs                    Interactive setup');
  console.log('  node setup-config.mjs <pat> [username]   Quick setup with PAT');
  console.log('  node setup-config.mjs --check            Verify configuration');
  console.log('  node setup-config.mjs --show             Show current config');
  console.log('  node setup-config.mjs --reset            Reset configuration');
  console.log('  node setup-config.mjs --help             Show this help');
  
  console.log('\nExamples:');
  console.log('  node setup-config.mjs abc123def456       # Set PAT only');
  console.log('  node setup-config.mjs abc123 \"张三\"       # Set PAT and username');
  console.log('  node setup-config.mjs --show             # Display current config');
  
  console.log('\nHow to get PAT Token:');
  console.log('  1. Login to TFS: http://tfs2018-web.winning.com.cn:8080/tfs/');
  console.log('  2. Click your avatar → Security → + Add → Personal Access Token');
  console.log('  3. Set name (e.g., "OpenWork Task Center") and expiration');
  console.log('  4. Select scopes:');
  console.log('     - Work Items: Read, Write, Manage');
  console.log('     - Code: Read, Write');
  console.log('  5. Copy the generated token');
}

/**
 * 交互式配置向导
 */
async function interactiveSetup() {
  printHeader('TFS Configuration Wizard');
  
  printInfo('This wizard will help you configure TFS connection.\n');
  
  // 检查现有配置
  if (fs.existsSync(CONFIG_PATH)) {
    printWarning('Existing configuration found!');
    print('dim', `  Location: ${CONFIG_PATH}`);
    
    try {
      const existing = loadConfigFile();
      if (existing.username) {
        printInfo(`  Username: ${existing.username}`);
      }
      printInfo(`  Server: ${existing.serverUrl || 'Not set'}`);
      printInfo(`  PAT: ${existing.pat ? '****' + existing.pat.slice(-4) : 'Not set'}`);
    } catch (e) {
      // ignore
    }
    
    console.log();
    const answer = await askQuestion('Do you want to overwrite? [y/N]: ');
    if (answer.toLowerCase() !== 'y') {
      printInfo('Setup cancelled. Current configuration kept.');
      return;
    }
  }
  
  console.log();
  print('bright', 'Step 1: TFS Server Configuration');
  print('dim', `Default: ${DEFAULT_SERVER_URL}`);
  
  const serverUrl = await askQuestion('Server URL [press Enter for default]: ');
  const finalServerUrl = serverUrl.trim() || DEFAULT_SERVER_URL;
  
  console.log();
  print('bright', 'Step 2: Personal Access Token (PAT)');
  print('dim', 'Your PAT token for TFS authentication');
  
  let pat = '';
  while (!pat) {
    pat = await askQuestion('PAT Token: ');
    pat = pat.trim();
    if (!pat) {
      printError('PAT Token is required!');
    }
  }
  
  console.log();
  print('bright', 'Step 3: Username (Optional)');
  print('dim', 'Your name for display purposes');
  
  const username = await askQuestion('Username [press Enter to skip]: ');
  const finalUsername = username.trim() || null;
  
  // 保存配置
  console.log();
  printInfo('Saving configuration...');
  
  try {
    const config = {
      serverUrl: finalServerUrl,
      pat: pat
    };
    
    if (finalUsername) {
      config.username = finalUsername;
    }
    
    saveConfigFile(config);
    
    printSuccess('Configuration saved successfully!');
    print('dim', `  Location: ${CONFIG_PATH}`);
    
    if (finalUsername) {
      printInfo(`  Username: ${finalUsername}`);
    }
    
    console.log();
    printInfo('Next steps:');
    console.log('  1. Test your configuration:');
    console.log('     node query-my-workitems.mjs');
    console.log('  2. Start using Task Center');
    
  } catch (error) {
    printError(`Failed to save configuration: ${error.message}`);
    process.exit(1);
  }
}

/**
 * 快速配置
 */
function quickSetup(pat, username) {
  if (!pat) {
    printError('PAT Token is required!');
    console.log('\nUsage: node setup-config.mjs <pat> [username]');
    console.log('   or: node setup-config.mjs --help');
    process.exit(1);
  }
  
  printHeader('Quick Setup');
  
  try {
    const config = {
      serverUrl: DEFAULT_SERVER_URL,
      pat: pat.trim()
    };
    
    if (username) {
      config.username = username.trim();
      printInfo(`Setting username: ${username}`);
    }
    
    saveConfigFile(config);
    
    printSuccess('Configuration saved!');
    print('dim', `  Server: ${DEFAULT_SERVER_URL}`);
    print('dim', `  PAT: ****${pat.slice(-4)}`);
    if (username) {
      print('dim', `  Username: ${username}`);
    }
    
    console.log();
    printInfo('Test your configuration:');
    console.log('  node query-my-workitems.mjs');
    
  } catch (error) {
    printError(`Failed to save: ${error.message}`);
    process.exit(1);
  }
}

/**
 * 验证配置
 */
async function verifyConfig() {
  printHeader('Configuration Verification');
  
  // 检查文件是否存在
  if (!fs.existsSync(CONFIG_PATH)) {
    printError('Configuration file not found!');
    console.log();
    printInfo('Please run setup first:');
    console.log('  node setup-config.mjs');
    process.exit(1);
  }
  
  printInfo('Configuration file found');
  print('dim', `  Path: ${CONFIG_PATH}`);
  
  // 解析配置
  let config;
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    config = JSON.parse(content);
    printSuccess('Configuration file is valid JSON');
  } catch (error) {
    printError('Invalid JSON in configuration file!');
    print('dim', `  Error: ${error.message}`);
    process.exit(1);
  }
  
  // 验证字段
  console.log();
  print('bright', 'Configuration Details:');
  
  // Username
  if (config.username) {
    printSuccess(`Username: ${config.username}`);
  } else {
    printWarning('Username: Not set (optional)');
  }
  
  // Server URL
  if (config.serverUrl) {
    printSuccess(`Server URL: ${config.serverUrl}`);
  } else {
    printWarning('Server URL: Using default');
    print('dim', `  Default: ${DEFAULT_SERVER_URL}`);
  }
  
  // PAT
  if (config.pat) {
    const masked = config.pat.substring(0, 4) + '****' + config.pat.slice(-4);
    printSuccess(`PAT Token: ${masked}`);
    printInfo(`Token length: ${config.pat.length} characters`);
  } else {
    printError('PAT Token: NOT SET');
    printInfo('Please configure your PAT token');
    process.exit(1);
  }
  
  // 尝试连接测试
  console.log();
  printInfo('Testing connection to TFS...');
  
  try {
    // 动态导入 azure-devops-node-api 进行测试
    const azureDevOps = await import('azure-devops-node-api');
    const WebApi = azureDevOps.WebApi;
    const getPersonalAccessTokenHandler = azureDevOps.getPersonalAccessTokenHandler;
    
    const authHandler = getPersonalAccessTokenHandler(config.pat);
    const connection = new WebApi(config.serverUrl || DEFAULT_SERVER_URL, authHandler);
    
    // 尝试获取项目列表来验证连接
    const coreApi = await connection.getCoreApi();
    const projects = await coreApi.getProjects();
    
    printSuccess('Connection successful!');
    printInfo(`Available projects: ${projects.length}`);
    
    // 显示前 5 个项目
    if (projects.length > 0) {
      console.log();
      print('bright', 'Sample Projects:');
      projects.slice(0, 5).forEach(p => {
        print('dim', `  • ${p.name}`);
      });
      if (projects.length > 5) {
        print('dim', `  ... and ${projects.length - 5} more`);
      }
    }
    
    console.log();
    printSuccess('✓ Configuration is valid and working!');
    
  } catch (error) {
    console.log();
    printError('Connection test failed!');
    print('dim', `  Error: ${error.message}`);
    
    if (error.message.includes('401') || error.message.includes('Unauthorized')) {
      console.log();
      printWarning('Authentication failed. Please check your PAT token:');
      console.log('  1. Is the token expired?');
      console.log('  2. Does it have the required permissions?');
      console.log('  3. Was it copied correctly?');
    }
    
    if (error.message.includes('getaddrinfo') || error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
      console.log();
      printWarning('Network error. Please check:');
      console.log('  1. Are you connected to the VPN?');
      console.log('  2. Is the TFS server accessible?');
      console.log('  3. Is the server URL correct?');
    }
    
    process.exit(1);
  }
}

/**
 * 显示当前配置
 */
function showCurrentConfig() {
  printHeader('Current Configuration');
  
  if (!fs.existsSync(CONFIG_PATH)) {
    printError('Configuration file not found!');
    console.log();
    printInfo('Please run setup first:');
    console.log('  node setup-config.mjs');
    process.exit(1);
  }
  
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(content);
    
    print('bright', 'Configuration File:');
    print('dim', `  ${CONFIG_PATH}`);
    console.log();
    
    print('bright', 'Settings:');
    
    if (config.username) {
      printSuccess(`Username: ${config.username}`);
    } else {
      printWarning('Username: Not set (optional)');
    }
    
    printSuccess(`Server: ${config.serverUrl || DEFAULT_SERVER_URL}`);
    
    if (config.pat) {
      const masked = '****' + config.pat.slice(-4);
      printSuccess(`PAT Token: ${masked}`);
    } else {
      printError('PAT Token: NOT SET');
    }
    
    console.log();
    printInfo('Raw configuration (masked):');
    console.log(JSON.stringify({
      ...config,
      pat: config.pat ? '****' + config.pat.slice(-4) : undefined
    }, null, 2));
    
  } catch (error) {
    printError(`Failed to read configuration: ${error.message}`);
    process.exit(1);
  }
}

/**
 * 重置配置
 */
function resetConfig() {
  printHeader('Reset Configuration');
  
  if (!fs.existsSync(CONFIG_PATH)) {
    printWarning('No configuration file found.');
    return;
  }
  
  try {
    fs.unlinkSync(CONFIG_PATH);
    printSuccess('Configuration file deleted.');
    printInfo('Please run setup again to configure:');
    console.log('  node setup-config.mjs');
  } catch (error) {
    printError(`Failed to delete configuration: ${error.message}`);
    process.exit(1);
  }
}

/**
 * 主函数
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  // 无参数 - 交互式配置
  if (!command) {
    await interactiveSetup();
    return;
  }
  
  // 处理选项
  switch (command) {
    case '--help':
    case '-h':
      showHelp();
      break;
      
    case '--check':
    case '-c':
    case '--verify':
      await verifyConfig();
      break;
      
    case '--show':
    case '-s':
      showCurrentConfig();
      break;
      
    case '--reset':
    case '-r':
      resetConfig();
      break;
      
    default:
      // 快速配置模式: setup-config.mjs <pat> [username]
      if (command.startsWith('--')) {
        printError(`Unknown option: ${command}`);
        console.log('\nRun "node setup-config.mjs --help" for usage information.');
        process.exit(1);
      }
      
      // 第一个参数是 PAT
      const pat = command;
      const username = args[1];
      quickSetup(pat, username);
  }
}

main().catch(error => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
