const Web3 = require('web3');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const winston = require('winston');

// ========== CONFIGURATION ========== //
const CONFIG = {
  // MONAD Network Settings
  RPC_URL: 'https://testnet-rpc.monad.xyz',
  EXPLORER_URL: 'https://testnet.monadexplorer.com/tx/',
  CHAIN_ID: 10143,
  GAS_PRICE: '1000000000', // 1 Gwei in wei
  GAS_LIMIT: 500000,

  // Telegram Settings
  TELEGRAM_TOKEN: '8044535899:AAGeJtCM8gV2GH-vlWerY-ie-y_K6phFmwY',
  ADMIN_ID: 6668515216,
  CONTRACT_ADDRESS: '0x1aa689f843077dca043df7d0dc0b3f62dbc6180d',

  // Security Settings
  MASTER_PASSWORD: process.env.MASTER_PASSWORD || 'change-this-in-production',
  TX_TIMEOUT: 120000, // 2 minutes
  MAX_RETRY_COUNT: 2
};

// Initialize Web3 and Bot
const web3 = new Web3(CONFIG.RPC_URL);
const bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: true });
const app = express();

// ========== WALLET ENCRYPTION ========== //
class WalletEncryption {
  constructor(masterPassword) {
    this.algorithm = 'aes-256-gcm';
    this.key = crypto.pbkdf2Sync(masterPassword, 'monad-mint-salt', 100000, 32, 'sha512');
  }

  encrypt(walletKey) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);
    let encrypted = cipher.update(walletKey, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return { iv: iv.toString('hex'), encryptedData: encrypted, authTag };
  }

  decrypt(encryptedWallet) {
    const iv = Buffer.from(encryptedWallet.iv, 'hex');
    const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv);
    decipher.setAuthTag(Buffer.from(encryptedWallet.authTag, 'hex'));
    let decrypted = decipher.update(encryptedWallet.encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}

// ========== WALLET MANAGER ========== //
class WalletManager {
  constructor(masterPassword) {
    this.encryption = new WalletEncryption(masterPassword);
    this.walletFile = './secure_wallets.json';
    this.wallets = this.loadWallets();
  }

  loadWallets() {
    try {
      if (fs.existsSync(this.walletFile)) {
        return JSON.parse(fs.readFileSync(this.walletFile, 'utf8'));
      }
      return [];
    } catch (error) {
      logger.error('Error loading wallets:', error);
      return [];
    }
  }

  saveWallets() {
    fs.writeFileSync(this.walletFile, JSON.stringify(this.wallets, null, 2));
  }

  addWallet(privateKey, label = '') {
    const cleanKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    if (!Validator.isValidPrivateKey(cleanKey)) {
      throw new Error('Invalid private key format');
    }
    
    const account = web3.eth.accounts.privateKeyToAccount(cleanKey);
    const existingWallet = this.wallets.find(w => 
      w.address.toLowerCase() === account.address.toLowerCase()
    );
    
    if (existingWallet) {
      throw new Error('Wallet already exists');
    }

    const encryptedWallet = this.encryption.encrypt(cleanKey);
    this.wallets.push({
      address: account.address,
      encryptedKey: encryptedWallet,
      label: label || `Wallet ${this.wallets.length + 1}`,
      active: true,
      lastUsed: null,
      addedAt: Date.now()
    });

    this.saveWallets();
    logAction('wallet_added', { address: account.address });
    return account.address;
  }

  getWallet(address) {
    const wallet = this.wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
    if (!wallet) return null;
    const privateKey = this.encryption.decrypt(wallet.encryptedKey);
    return { ...wallet, privateKey };
  }

  getActiveWallets() {
    return this.wallets.filter(w => w.active);
  }

  toggleWallet(address) {
    const walletIndex = this.wallets.findIndex(w => 
      w.address.toLowerCase() === address.toLowerCase()
    );
    
    if (walletIndex >= 0) {
      this.wallets[walletIndex].active = !this.wallets[walletIndex].active;
      this.saveWallets();
      logAction('wallet_toggled', { 
        address, 
        active: this.wallets[walletIndex].active 
      });
      return this.wallets[walletIndex].active;
    }
    return null;
  }

  removeWallet(address) {
    const initialLength = this.wallets.length;
    this.wallets = this.wallets.filter(w => 
      w.address.toLowerCase() !== address.toLowerCase()
    );
    
    if (this.wallets.length < initialLength) {
      this.saveWallets();
      logAction('wallet_removed', { address });
      return true;
    }
    return false;
  }

  updateLastUsed(address, timestamp = Date.now()) {
    const walletIndex = this.wallets.findIndex(w => 
      w.address.toLowerCase() === address.toLowerCase()
    );
    
    if (walletIndex >= 0) {
      this.wallets[walletIndex].lastUsed = timestamp;
      this.saveWallets();
    }
  }
}

// ========== TRANSACTION MANAGER ========== //
class TransactionManager {
  constructor(web3) {
    this.web3 = web3;
    this.pendingNonces = new Map();
    this.txHistory = [];
    this.maxHistoryItems = 100;
    this.historyFile = './tx_history.json';
    
    this.loadHistory();
  }
  
  loadHistory() {
    try {
      if (fs.existsSync(this.historyFile)) {
        this.txHistory = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
        logger.info('Transaction history loaded', { count: this.txHistory.length });
      }
    } catch (error) {
      logger.error('Error loading transaction history', { error: error.message });
    }
  }
  
  saveHistory() {
    try {
      fs.writeFileSync(this.historyFile, JSON.stringify(this.txHistory, null, 2));
    } catch (error) {
      logger.error('Error saving transaction history', { error: error.message });
    }
  }

  async getNonce(address) {
    const onChainNonce = await this.web3.eth.getTransactionCount(address);
    const pendingNonce = this.pendingNonces.get(address) || onChainNonce;
    const nonce = Math.max(onChainNonce, pendingNonce);
    this.pendingNonces.set(address, nonce + 1);
    return nonce;
  }

  async sendTransaction(signedTx, walletAddress, options = {}) {
    const txHash = this.web3.utils.sha3(signedTx.rawTransaction);
    const startTime = Date.now();
    
    const txRecord = {
      hash: txHash,
      from: walletAddress,
      to: options.to || 'unknown',
      timestamp: startTime,
      status: 'pending',
      gasPrice: options.gasPrice || 'unknown',
      gasLimit: options.gasLimit || 'unknown'
    };
    
    this.txHistory.unshift(txRecord);
    if (this.txHistory.length > this.maxHistoryItems) {
      this.txHistory.pop();
    }
    
    this.saveHistory();
    
    const timeout = options.timeout || CONFIG.TX_TIMEOUT;
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Transaction timeout')), timeout);
    });
    
    try {
      const receipt = await Promise.race([
        this.web3.eth.sendSignedTransaction(signedTx.rawTransaction),
        timeoutPromise
      ]);
      
      txRecord.status = 'confirmed';
      txRecord.blockNumber = receipt.blockNumber;
      txRecord.gasUsed = receipt.gasUsed;
      this.saveHistory();
      
      return receipt;
    } catch (error) {
      txRecord.status = 'failed';
      txRecord.error = error.message;
      this.saveHistory();
      
      if (error.message.includes('nonce') || error.message.includes('underpriced')) {
        this.pendingNonces.delete(walletAddress);
      }
      throw error;
    }
  }

  getTransactionHistory(address = null, limit = 10) {
    if (address) {
      return this.txHistory
        .filter(tx => tx.from.toLowerCase() === address.toLowerCase())
        .slice(0, limit);
    }
    return this.txHistory.slice(0, limit);
  }
}

// ========== NFT CONTRACT SETUP ========== //
const contractABI = [{
  "inputs": [],
  "name": "mint",
  "outputs": [],
  "stateMutability": "payable",
  "type": "function"
}, {
  "inputs": [],
  "name": "totalSupply",
  "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
  "stateMutability": "view",
  "type": "function"
}, {
  "inputs": [],
  "name": "MAX_SUPPLY",
  "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
  "stateMutability": "view",
  "type": "function"
}];

let contract = new web3.eth.Contract(contractABI, CONFIG.CONTRACT_ADDRESS);

// ========== CORE MINT FUNCTION ========== //
async function sendMonadMintTx(walletAddress, msg, retryCount = 0) {
  try {
    const wallet = walletManager.getWallet(walletAddress);
    if (!wallet || !wallet.active) {
      throw new Error(`Wallet ${walletAddress} not found or inactive`);
    }
    
    logAction('mint_attempt', { address: walletAddress, retryCount });
    
    const account = web3.eth.accounts.privateKeyToAccount(wallet.privateKey);
    const nonce = await txManager.getNonce(account.address);
    
    const tx = {
      from: account.address,
      to: CONFIG.CONTRACT_ADDRESS,
      data: contract.methods.mint().encodeABI(),
      gas: CONFIG.GAS_LIMIT,
      gasPrice: CONFIG.GAS_PRICE,
      chainId: CONFIG.CHAIN_ID,
      nonce
    };

    const signedTx = await account.signTransaction(tx);
    
    bot.sendMessage(msg.chat.id, `⏳ Processing mint from ${TelegramFormatter.code(account.address.substring(0, 10) + '...')}`, { parse_mode: 'Markdown' });
    
    const receipt = await txManager.sendTransaction(signedTx, account.address, {
      to: CONFIG.CONTRACT_ADDRESS,
      gasPrice: CONFIG.GAS_PRICE,
      gasLimit: CONFIG.GAS_LIMIT,
      timeout: CONFIG.TX_TIMEOUT
    });
    
    walletManager.updateLastUsed(account.address);
    
    bot.sendMessage(msg.chat.id, TelegramFormatter.transactionSuccess(receipt.transactionHash, account.address), { parse_mode: 'Markdown' });
    return receipt;
  } catch (error) {
    if (retryCount < CONFIG.MAX_RETRY_COUNT) {
      bot.sendMessage(msg.chat.id, `🔄 Retrying (${retryCount + 1}/${CONFIG.MAX_RETRY_COUNT})...\nError: ${error.message.substring(0, 100)}`, { parse_mode: 'Markdown' });
      await new Promise(resolve => setTimeout(resolve, 3000));
      return sendMonadMintTx(walletAddress, msg, retryCount + 1);
    }
    
    logger.error('mint_failed', { address: walletAddress, error: error.message, stack: error.stack });
    bot.sendMessage(msg.chat.id, TelegramFormatter.transactionFailed(error.message, walletAddress), { parse_mode: 'Markdown' });
    throw error;
  }
}

// ========== TELEGRAM COMMAND HANDLERS ========== //
bot.onText(/\/start/, (msg) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;
  
  bot.sendMessage(msg.chat.id, TelegramFormatter.helpText(), { parse_mode: 'Markdown' });
});

bot.onText(/\/mint/, (msg) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;
  
  const activeWallets = walletManager.getActiveWallets();
  if (activeWallets.length === 0) {
    return bot.sendMessage(msg.chat.id, '❌ No active wallets configured. Use /addwallet to add wallets.');
  }
  
  bot.sendMessage(msg.chat.id, `🚀 Starting batch mint with ${activeWallets.length} wallets...`);
  
  Promise.all(activeWallets.map(wallet => sendMonadMintTx(wallet.address, msg)))
    .then(receipts => {
      const successful = receipts.filter(r => r).length;
      bot.sendMessage(msg.chat.id, `🎉 Batch mint complete!\n✅ ${successful}/${activeWallets.length} successful`);
    })
    .catch(error => {
      logger.error('batch_mint_error', { error: error.message });
      bot.sendMessage(msg.chat.id, `⚠️ Some mints failed, check /history for details`);
    });
});

bot.onText(/\/status/, async (msg) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;
  
  try {
    bot.sendMessage(msg.chat.id, '⏳ Fetching contract status...');
    const [total, max] = await Promise.all([
      contract.methods.totalSupply().call(),
      contract.methods.MAX_SUPPLY().call(),
    ]);
    bot.sendMessage(msg.chat.id, TelegramFormatter.supplyStatus(total, max), { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('status_check_error', { error: error.message });
    bot.sendMessage(msg.chat.id, `❌ Error fetching supply: ${error.message}`);
  }
});

// Wallet Management Commands
bot.onText(/\/addwallet (.+)/, (msg, match) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;

  const privateKey = match[1].trim();
  try {
    const address = walletManager.addWallet(privateKey);
    bot.sendMessage(msg.chat.id, `✅ Wallet added successfully!\nAddress: ${address}`);
  } catch (error) {
    bot.sendMessage(msg.chat.id, `❌ Error adding wallet: ${error.message}`);
  }
});

bot.onText(/\/wallets/, (msg) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;

  const wallets = walletManager.getActiveWallets();
  if (wallets.length === 0) {
    return bot.sendMessage(msg.chat.id, '📝 No wallets configured');
  }
  
  bot.sendMessage(msg.chat.id, TelegramFormatter.walletList(wallets), { parse_mode: 'Markdown' });
});

bot.onText(/\/togglewallet (.+)/, (msg, match) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;

  const address = match[1].trim();
  const newStatus = walletManager.toggleWallet(address);
  if (newStatus !== null) {
    bot.sendMessage(msg.chat.id, `✅ Wallet ${newStatus ? 'activated' : 'deactivated'}: ${address}`);
  } else {
    bot.sendMessage(msg.chat.id, '❌ Wallet not found');
  }
});

bot.onText(/\/removewallet (.+)/, (msg, match) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;

  const address = match[1].trim();
  const success = walletManager.removeWallet(address);
  if (success) {
    bot.sendMessage(msg.chat.id, `✅ Wallet removed: ${address}`);
  } else {
    bot.sendMessage(msg.chat.id, '❌ Wallet not found');
  }
});

// Transaction History Commands
bot.onText(/\/history(?:\s+(\d+))?/, (msg, match) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;

  const limit = match[1] ? parseInt(match[1]) : 5;
  const history = txManager.getTransactionHistory(null, limit);
  
  if (history.length === 0) {
    return bot.sendMessage(msg.chat.id, '📜 No transaction history available');
  }
  
  let message = '📜 *Recent Transactions*\n\n';
  
  history.forEach((tx, index) => {
    const date = new Date(tx.timestamp).toLocaleString();
    const statusEmoji = tx.status === 'confirmed' ? '✅' : 
                        tx.status === 'pending' ? '⏳' : '❌';
    
    message += `*${index + 1}. ${statusEmoji} ${tx.status.toUpperCase()}*\n` +
               `Time: ${date}\n` +
               `From: \`${tx.from.substring(0, 10)}...\`\n` +
               `Tx: [${tx.hash.substring(0, 10)}...](${CONFIG.EXPLORER_URL}${tx.hash})\n\n`;
  });
  
  bot.sendMessage(msg.chat.id, message, { 
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  });
});

bot.onText(/\/wallethistory (.+)/, (msg, match) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;

  const address = match[1].trim();
  if (!Validator.isValidAddress(address)) {
    return bot.sendMessage(msg.chat.id, '❌ Invalid wallet address');
  }

  const history = txManager.getTransactionHistory(address, 10);
  
  if (history.length === 0) {
    return bot.sendMessage(msg.chat.id, `📜 No transaction history for \`${address}\``, { parse_mode: 'Markdown' });
  }
  
  let message = `📜 *Transaction History for*\n\`${address}\`\n\n`;
  
  history.forEach((tx, index) => {
    const date = new Date(tx.timestamp).toLocaleString();
    const statusEmoji = tx.status === 'confirmed' ? '✅' : 
                        tx.status === 'pending' ? '⏳' : '❌';
    
    message += `*${index + 1}. ${statusEmoji} ${tx.status.toUpperCase()}*\n` +
               `Time: ${date}\n` +
               `Tx: [${tx.hash.substring(0, 10)}...](${CONFIG.EXPLORER_URL}${tx.hash})\n\n`;
  });
  
  bot.sendMessage(msg.chat.id, message, { 
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  });
});

// ========== SERVER SETUP ========== //
app.get('/', (req, res) => res.send('MONAD Mint Bot 🚀'));
app.listen(3000, () => console.log('Server running on port 3000'));

console.log('🤖 Bot started!');
      
