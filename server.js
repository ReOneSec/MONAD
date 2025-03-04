const { Web3 } = require('web3');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
require('dotenv').config();

// ====== CONFIG ====== //
const CONFIG = {
  RPC_URL: process.env.RPC_URL || 'https://testnet-rpc.monad.xyz',
  EXPLORER_URL: process.env.EXPLORER_URL || 'https://testnet.monadexplorer.com/tx/',
  CHAIN_ID: parseInt(process.env.CHAIN_ID || '10143'), 
  GAS_LIMIT: parseInt(process.env.GAS_LIMIT || '500000'),
  GAS_PRICE: process.env.GAS_PRICE || '52000000000',
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  ADMIN_IDS: process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id)) : [6668515216],
  CHANNEL_ID: process.env.CHANNEL_ID || '@your_channel',
  CONTRACT_ADDRESS: process.env.CONTRACT_ADDRESS || '',
  WALLETS: process.env.WALLETS ? process.env.WALLETS.split(',').filter(key => key.trim() !== '') : []
};

// ====== INIT ====== //
const web3 = new Web3(CONFIG.RPC_URL);
let bot;
let contract;
const app = express();

// ====== HELPER FUNCTIONS ====== //

// Validate critical configuration parameters
function validateConfig() {
  const requiredVars = ['TELEGRAM_TOKEN'];
  const missingVars = requiredVars.filter(varName => !process.env[varName]);
  
  if (missingVars.length > 0) {
    console.error(`Error: Missing required environment variables: ${missingVars.join(', ')}`);
    process.exit(1);
  }
  
  if (!CONFIG.CONTRACT_ADDRESS || !web3.utils.isAddress(CONFIG.CONTRACT_ADDRESS)) {
    console.warn('Warning: Invalid or missing contract address');
  }
  
  if (CONFIG.WALLETS.length === 0) {
    console.warn('Warning: No wallets configured');
  }
  
  console.log('Configuration validated');
}

// Load saved config from file
function loadConfig() {
  try {
    if (fs.existsSync('config.json')) {
      const savedConfig = JSON.parse(fs.readFileSync('config.json', 'utf8'));
      CONFIG.CONTRACT_ADDRESS = savedConfig.contractAddress || CONFIG.CONTRACT_ADDRESS;
      CONFIG.CHANNEL_ID = savedConfig.channelId || CONFIG.CHANNEL_ID;
      console.log('Config loaded successfully');
    }
  } catch (e) {
    console.error('Error loading config:', e.message);
    console.log('Using default config');
  }
}

// Save config to file
function saveConfig() {
  try {
    fs.writeFileSync('config.json', JSON.stringify({
      contractAddress: CONFIG.CONTRACT_ADDRESS,
      channelId: CONFIG.CHANNEL_ID
    }, null, 2));
    console.log('Config saved successfully');
  } catch (e) {
    console.error('Error saving config:', e.message);
  }
}

// Initialize contract with ABI
function initializeContract() {
  if (!CONFIG.CONTRACT_ADDRESS || !web3.utils.isAddress(CONFIG.CONTRACT_ADDRESS)) {
    console.warn('Invalid or missing contract address');
    return false;
  }
  
  const contractABI = [
    {
      "inputs": [],
      "name": "mint",
      "outputs": [],
      "stateMutability": "payable",
      "type": "function"
    }
  ];
  
  try {
    contract = new web3.eth.Contract(contractABI, CONFIG.CONTRACT_ADDRESS);
    console.log(`Contract initialized at ${CONFIG.CONTRACT_ADDRESS}`);
    return true;
  } catch (error) {
    console.error('Contract initialization error:', error.message);
    return false;
  }
}

// Initialize Telegram bot
function initializeBot() {
  if (!CONFIG.TELEGRAM_TOKEN) {
    console.error('TELEGRAM_TOKEN not provided in environment variables');
    process.exit(1);
  }
  
  try {
    bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: true });
    console.log('Telegram bot initialized');
    setupBotCommands();
  } catch (error) {
    console.error('Bot initialization error:', error.message);
    process.exit(1);
  }
}

// Helper function to send messages with Markdown formatting
async function sendMessage(chatId, message) {
  try {
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    
    // Only send to channel if it's a valid channel ID and different from the chat
    if (CONFIG.CHANNEL_ID && 
        (CONFIG.CHANNEL_ID.startsWith('@') || CONFIG.CHANNEL_ID.startsWith('-')) && 
        CONFIG.CHANNEL_ID !== chatId.toString()) {
      await bot.sendMessage(CONFIG.CHANNEL_ID, message, { parse_mode: 'Markdown' });
    }
  } catch (error) {
    console.error('Error sending message:', error.message);
    
    // If channel message fails, try to notify the original chat
    if (error.message.includes(CONFIG.CHANNEL_ID)) {
      try {
        await bot.sendMessage(chatId, `⚠️ Failed to send notification to channel: ${error.message}`);
      } catch (e) {
        console.error('Failed to send error notification:', e.message);
      }
    }
  }
}

// Check if user is admin
function isAdmin(userId) {
  return CONFIG.ADMIN_IDS.includes(userId);
}

// ====== CORE FUNCTION ====== //
async function mintNFT(walletKey, chatId) {
  if (!contract) {
    await sendMessage(chatId, "❌ Contract not properly initialized");
    return;
  }

  try {
    // Validate private key format
    if (!walletKey.startsWith('0x')) {
      walletKey = '0x' + walletKey;
    }
    
    const account = web3.eth.accounts.privateKeyToAccount(walletKey);
    const address = account.address;

    // Check balance
    const balance = await web3.eth.getBalance(address);
    const balanceBN = BigInt(balance);
    const gasCostBN = BigInt(CONFIG.GAS_LIMIT) * BigInt(CONFIG.GAS_PRICE);
    
    if (balanceBN < gasCostBN) {
      const ethBalance = web3.utils.fromWei(balance, 'ether');
      const ethNeeded = web3.utils.fromWei(gasCostBN.toString(), 'ether');
      await sendMessage(chatId, `❌ Insufficient balance in \`${address}\`\nHas: ${ethBalance} ETH\nNeeds: ~${ethNeeded} ETH`);
      return;
    }

    // Optional gas estimation (commented out as it requires contract deployment)
    /*
    try {
      const estimatedGas = await contract.methods.mint().estimateGas({ from: address });
      CONFIG.GAS_LIMIT = Math.ceil(estimatedGas * 1.1); // Add 10% buffer
      console.log(`Estimated gas: ${estimatedGas}, using: ${CONFIG.GAS_LIMIT}`);
    } catch (gasError) {
      console.warn("Gas estimation failed, using default gas limit:", gasError.message);
    }
    */

    // Prepare transaction
    const tx = {
      from: address,
      to: CONFIG.CONTRACT_ADDRESS,
      data: contract.methods.mint().encodeABI(),
      gas: CONFIG.GAS_LIMIT,
      gasPrice: CONFIG.GAS_PRICE,
      chainId: CONFIG.CHAIN_ID
    };

    await sendMessage(chatId, `🔄 Minting from \`${address}\`...`);
    
    // Sign and send transaction
    const signedTx = await account.signTransaction(tx);
    const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
    
    // Success message with transaction link
    await sendMessage(chatId, `✅ Mint successful from \`${address}\`\n[View Transaction](${CONFIG.EXPLORER_URL}${receipt.transactionHash})`);
  } catch (error) {
    console.error('Mint error:', error);
    
    // Format error message
    let errorMsg = error.message;
    if (errorMsg.length > 100) {
      errorMsg = errorMsg.substring(0, 100) + '...';
    }
    
    await sendMessage(chatId, `❌ Mint failed: ${errorMsg}`);
  }
}

// ====== BOT COMMANDS ====== //
function setupBotCommands() {
  // Mint command
  bot.onText(/\/mint/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAdmin(msg.from.id)) {
      return bot.sendMessage(chatId, '⛔ You are not authorized to use this command');
    }
    
    if (CONFIG.WALLETS.length === 0) {
      return bot.sendMessage(chatId, '⚠️ No wallets configured. Add wallets using the WALLETS environment variable.');
    }
    
    await bot.sendMessage(chatId, `🚀 Starting mint process for ${CONFIG.WALLETS.length} wallet(s)...`);
    
    // Process wallets sequentially to avoid rate limiting
    for (const wallet of CONFIG.WALLETS) {
      await mintNFT(wallet, chatId);
      // Small delay between mints
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  });

  // Set contract address
  bot.onText(/\/setcontract (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    
    if (!isAdmin(msg.from.id)) {
      return bot.sendMessage(chatId, '⛔ You are not authorized to use this command');
    }

    const newAddress = match[1].trim();
    if (!web3.utils.isAddress(newAddress)) {
      return bot.sendMessage(chatId, '❌ Invalid contract address format');
    }

    CONFIG.CONTRACT_ADDRESS = newAddress;
    if (initializeContract()) {
      saveConfig();
      await sendMessage(chatId, `📝 Contract address updated to \`${newAddress}\``);
    } else {
      await sendMessage(chatId, '❌ Failed to initialize contract with new address');
    }
  });

  // Set notification channel
  bot.onText(/\/setchannel (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    
    if (!isAdmin(msg.from.id)) {
      return bot.sendMessage(chatId, '⛔ You are not authorized to use this command');
    }

    const newChannel = match[1].trim();
    if (!newChannel.startsWith('@') && !newChannel.startsWith('-')) {
      return bot.sendMessage(chatId, '❌ Invalid channel ID. Must start with @ or -');
    }

    CONFIG.CHANNEL_ID = newChannel;
    saveConfig();
    await sendMessage(chatId, `📢 Notification channel updated to \`${newChannel}\``);
  });

  // Check wallet balance
  bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAdmin(msg.from.id)) {
      return bot.sendMessage(chatId, '⛔ You are not authorized to use this command');
    }

    if (CONFIG.WALLETS.length === 0) {
      return bot.sendMessage(chatId, '⚠️ No wallets configured');
    }

    await bot.sendMessage(chatId, '💰 Checking wallet balances...');
    
    for (const wallet of CONFIG.WALLETS) {
      try {
        // Validate private key format
        const walletKey = wallet.startsWith('0x') ? wallet : '0x' + wallet;
        const account = web3.eth.accounts.privateKeyToAccount(walletKey);
        const balance = await web3.eth.getBalance(account.address);
        const ethBalance = web3.utils.fromWei(balance, 'ether');
        
        await bot.sendMessage(chatId, `💰 Balance of \`${account.address}\`: ${ethBalance} ETH`);
      } catch (error) {
        await bot.sendMessage(chatId, `❌ Error checking wallet: ${error.message}`);
      }
      
      // Small delay between balance checks
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  });

  // Status command
  bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAdmin(msg.from.id)) {
      return bot.sendMessage(chatId, '⛔ You are not authorized to use this command');
    }

    const status = `
*MONAD Bot Status*

🔗 Network: \`${CONFIG.RPC_URL}\`
🔢 Chain ID: \`${CONFIG.CHAIN_ID}\`
📄 Contract: \`${CONFIG.CONTRACT_ADDRESS || 'Not set'}\`
📢 Channel: \`${CONFIG.CHANNEL_ID}\`
👛 Wallets: \`${CONFIG.WALLETS.length}\`
⛽ Gas Limit: \`${CONFIG.GAS_LIMIT}\`
💰 Gas Price: \`${CONFIG.GAS_PRICE}\`
`;
    
    await bot.sendMessage(chatId, status, { parse_mode: 'Markdown' });
  });

  // Help command
  bot.onText(/\/help/, (msg) => {
    const helpMessage = `
*MONAD Bot Commands*

/mint - Mint NFTs from all configured wallets
/setcontract <address> - Set contract address
/setchannel <channel> - Set notification channel
/balance - Check all wallet balances
/status - Show current bot configuration
/help - Show this help message
`;
    bot.sendMessage(msg.chat.id, helpMessage, { parse_mode: 'Markdown' });
  });

  // Handle errors
  bot.on('polling_error', (error) => {
    console.error('Polling error:', error.message);
  });
}

// ====== INITIALIZATION ====== //
function initialize() {
  console.log('Starting MONAD Bot...');
  validateConfig();
  loadConfig();
  initializeContract();
  initializeBot();
}

// ====== SERVER ====== //
app.get('/', (req, res) => res.send('MONAD Bot 🚀 Running'));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Start the bot
initialize();
