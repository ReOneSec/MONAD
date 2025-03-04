const Web3 = require('web3');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const winston = require('winston');

// Initialize Web3 first so we can use it in CONFIG
const web3 = new Web3('https://testnet-rpc.monad.xyz');

// ====== LOGGER SETUP ====== //
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Mask sensitive data in logs
const maskSensitiveData = winston.format((info) => {
  if (info.privateKey) {
    info.privateKey = info.privateKey.replace(/^(.{6}).+(.{4})$/, '$1...$2');
  }
  return info;
});

logger.format = winston.format.combine(
  maskSensitiveData(),
  logger.format
);

// ====== CONFIGURATION ====== //
const CONFIG = {
  RPC_URL: 'https://testnet-rpc.monad.xyz',
  EXPLORER_URL: 'https://testnet.monadexplorer.com/tx/',
  CHAIN_ID: 10143,
  GAS_PRICE: web3.utils.toWei('1', 'gwei'),
  GAS_LIMIT: 500000,

  TELEGRAM_TOKEN: 'YOUR_TELEGRAM_BOT_TOKEN',
  ADMIN_ID: 6668515216,
  CONTRACT_ADDRESS: '0x1aa689f843077dca043df7d0dc0b3f62dbc6180d',
  WALLETS_FILE: 'wallets.enc',
  ENCRYPTION_PASSWORD: 'your-strong-password',
  PORT: 3000
};

// Create data directory if it doesn't exist
const dataDir = './data';
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

// File paths
const walletsPath = path.join(dataDir, CONFIG.WALLETS_FILE);
const txHistoryPath = path.join(dataDir, 'transactions.json');

// Initialize Bot and Express app
const bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: true });
const app = express();
let contract;
let wallets = [];

// ====== SECURE WALLET STORAGE ====== //
function encryptWallets(data, password) {
  const iv = crypto.randomBytes(16);
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32);
  
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const hmac = crypto.createHmac('sha256', key).update(encrypted).digest('hex');
  
  return {
    iv: iv.toString('hex'),
    salt: salt.toString('hex'),
    encryptedData: encrypted,
    hmac: hmac
  };
}

function decryptWallets(encryptedData, password) {
  const iv = Buffer.from(encryptedData.iv, 'hex');
  const salt = Buffer.from(encryptedData.salt, 'hex');
  const key = crypto.scryptSync(password, salt, 32);
  
  const hmac = crypto.createHmac('sha256', key).update(encryptedData.encryptedData).digest('hex');
  
  if (hmac !== encryptedData.hmac) {
    throw new Error('Data integrity check failed. Possible tampering detected.');
  }
  
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encryptedData.encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return JSON.parse(decrypted);
}

function loadWallets() {
  try {
    if (fs.existsSync(walletsPath)) {
      const encryptedData = JSON.parse(fs.readFileSync(walletsPath, 'utf8'));
      wallets = decryptWallets(encryptedData, CONFIG.ENCRYPTION_PASSWORD);
      logger.info(`Loaded ${wallets.length} wallets`);
    } else {
      logger.warn('No wallets found');
    }
  } catch (error) {
    logger.error(`Failed to load wallets: ${error.message}`);
    wallets = [];
  }
}

function saveWallets() {
  try {
    const encryptedData = encryptWallets(wallets, CONFIG.ENCRYPTION_PASSWORD);
    fs.writeFileSync(walletsPath, JSON.stringify(encryptedData));
    logger.info('Wallets saved successfully');
  } catch (error) {
    logger.error(`Failed to save wallets: ${error.message}`);
  }
}

// ====== INPUT VALIDATION ====== //
function validateAddress(address) {
  return web3.utils.isAddress(address);
}

function validatePrivateKey(key) {
  try {
    const account = web3.eth.accounts.privateKeyToAccount(key);
    return !!account.address;
  } catch (error) {
    return false;
  }
}

function sanitizeInput(input) {
  return input.replace(/[<>]/g, '').replace(/`/g, '\'').trim();
}

// ====== CONTRACT INITIALIZATION ====== //
const contractABI = [{
  "inputs": [],
  "name": "mint",
  "outputs": [],
  "stateMutability": "payable",
  "type": "function"
}];

function initializeContract() {
  if (!validateAddress(CONFIG.CONTRACT_ADDRESS)) {
    logger.error('Invalid contract address');
    return false;
  }
  contract = new web3.eth.Contract(contractABI, CONFIG.CONTRACT_ADDRESS);
  return true;
}

// ====== SECURE TRANSACTION HANDLING ====== //
async function sendMonadMintTx(walletKey, msg, retryCount = 0) {
  try {
    const account = web3.eth.accounts.privateKeyToAccount(walletKey);
    const nonce = await web3.eth.getTransactionCount(account.address, 'pending');
    
    const tx = {
      from: account.address,
      to: CONFIG.CONTRACT_ADDRESS,
      data: contract.methods.mint().encodeABI(),
      gas: CONFIG.GAS_LIMIT,
      gasPrice: CONFIG.GAS_PRICE,
      chainId: CONFIG.CHAIN_ID,
      nonce: nonce
    };

    const signedTx = await account.signTransaction(tx);
    const receipt = await Promise.race([
      web3.eth.sendSignedTransaction(signedTx.rawTransaction),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Transaction timed out')), 60000))
    ]);
    
    bot.sendMessage(
      msg.chat.id,
      `✅ Mint successful!\n${CONFIG.EXPLORER_URL}${receipt.transactionHash}`
    );
    saveTxHistory({ address: account.address, txHash: receipt.transactionHash, status: 'success' });
    return receipt;
  } catch (error) {
    if (retryCount < 2) {
      bot.sendMessage(msg.chat.id, `🔄 Retrying (${retryCount + 1}/2)...`);
      return sendMonadMintTx(walletKey, msg, retryCount + 1);
    }
    bot.sendMessage(msg.chat.id, `❌ Final attempt failed: ${error.message}`);
    saveTxHistory({ address: web3.eth.accounts.privateKeyToAccount(walletKey).address, error: error.message, status: 'failed' });
  }
}

// ====== TRANSACTION HISTORY ====== //
function saveTxHistory(tx) {
  try {
    let history = [];
    if (fs.existsSync(txHistoryPath)) {
      history = JSON.parse(fs.readFileSync(txHistoryPath, 'utf8'));
    }
    history.push({ ...tx, timestamp: Date.now() });
    if (history.length > 100) {
      history = history.slice(-100);
    }
    fs.writeFileSync(txHistoryPath, JSON.stringify(history, null, 2));
  } catch (error) {
    logger.error(`Failed to save transaction history: ${error.message}`);
  }
}

function getTxHistory(limit = 10) {
  try {
    if (fs.existsSync(txHistoryPath)) {
      const history = JSON.parse(fs.readFileSync(txHistoryPath, 'utf8'));
      return history.slice(-limit).reverse();
    }
    return [];
  } catch (error) {
    logger.error(`Failed to retrieve transaction history: ${error.message}`);
    return [];
  }
}

// ====== TELEGRAM COMMANDS ====== //
bot.onText(/\/start/, (msg) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;
  bot.sendMessage(msg.chat.id, '🤖 MONAD Mint Bot Active\n/mint - Start minting\n/status - Check supply\n/history - View transaction history');
});

bot.onText(/\/mint/, (msg) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;
  
  Promise.all(CONFIG.WALLETS.map(wallet => 
    sendMonadMintTx(wallet, msg)
  ))
  .then(() => bot.sendMessage(msg.chat.id, '🎉 Batch mint complete!'))
  .catch(() => bot.sendMessage(msg.chat.id, '⚠️ Some mints failed, check logs'));
});

bot.onText(/\/status/, async (msg) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;
  
  try {
    const [totalSupply, maxSupply] = await Promise.all([
      contract.methods.totalSupply().call(),
      contract.methods.MAX_SUPPLY().call()
    ]);
    bot.sendMessage(msg.chat.id, `📊 Supply: ${totalSupply}/${maxSupply}\nRemaining: ${maxSupply - totalSupply}`);
  } catch (error) {
    bot.sendMessage(msg.chat.id, `❌ Error fetching supply: ${error.message}`);
  }
});

bot.onText(/\/history/, (msg) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;
  
  const history = getTxHistory();
  if (history.length === 0) {
    bot.sendMessage(msg.chat.id, '📜 No transaction history found');
    return;
  }
  
  let message = '📜 Recent Transactions:\n\n';
  history.forEach((tx, index) => {
    const date = new Date(tx.timestamp).toLocaleString();
    message += `${index + 1}. ${tx.status === 'success' ? '✅' : '❌'}\n`;
    message += `   Date: ${date}\n`;
    if (tx.status === 'success') {
      message += `   TX: ${CONFIG.EXPLORER_URL}${tx.txHash}\n\n`;
    } else {
      message += `   Error: ${tx.error}\n\n`;
    }
  });
  
  bot.sendMessage(msg.chat.id, message);
});

// ====== SERVER SETUP ====== //
app.get('/', (req, res) => res.send('MONAD Mint Bot 🚀'));
app.listen(CONFIG.PORT, () => console.log(`Server running on port ${CONFIG.PORT}`));

console.log('🤖 Bot started!');

// Load wallets and initialize
loadWallets();
initializeContract();
      
