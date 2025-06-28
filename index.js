const express = require("express");
const bodyParser = require("body-parser");
const { format } = require("date-fns");
const axios = require("axios");
const Joi = require("joi");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const winston = require("winston");
const morgan = require("morgan");

require('dotenv').config();

// Constants
const PORT = process.env.PORT || 3000;
const API_URL = process.env.API_URL;
const NODE_ENV = process.env.NODE_ENV || 'development';
const API_TIMEOUT = parseInt(process.env.API_TIMEOUT) || 5000;

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'webhook.log' })
  ]
});

// Express setup
const app = express();

// Security middlewares
app.use(helmet());
app.use(bodyParser.json({ limit: '10kb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Request logging
app.use(morgan(NODE_ENV === 'development' ? 'dev' : 'combined', {
  stream: { write: (message) => logger.info(message.trim()) }
}));

// Validation schemas
const orderSchema = Joi.object({
  test: Joi.string().optional(),
  payment: Joi.object({
    amount: Joi.number().optional(),
    orderid: Joi.string().optional(),
    products: Joi.array().items(
        Joi.object({
          name: Joi.string().optional(),
          quantity: Joi.number().min(1).optional(),
          price: Joi.number().min(0).optional(),
          amount: Joi.number().min(0).optional(),
          options: Joi.array().items(
              Joi.object({
                option: Joi.string().optional(),
                variant: Joi.string().optional()
              })
          ).optional()
        })
    ).min(1).optional()
  }).optional(),
  ma_email: Joi.string().email().optional()
}).options({ allowUnknown: true });

// Helpers
const formatProductOption = (option) => `${option.option}: ${option.variant}`;

const formatProductLine = (product) => {
  const baseText = `${product.name}`;
  const optionsText = product.options
      ? ` (${product.options.map(formatProductOption).join(", ")})`
      : "";
  const quantityPrice = ` – ${product.quantity}x${product.price}=${product.amount};`;

  return `${baseText}${optionsText}${quantityPrice}`;
};

const createTransactionItem = (orderData) => ({
  total: orderData.payment.amount,
  date: format(new Date(), "dd.MM.yyyy"),
  email: orderData.ma_email,
  id: orderData.payment.orderid,
  items: orderData.payment.products.map(formatProductLine).join(""),
});

const sendToApi = async (transactionItem) => {
  try {
    const response = await axios.post(API_URL, transactionItem, {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: API_TIMEOUT,
      httpsAgent: new (require('https').Agent)({
        rejectUnauthorized: NODE_ENV !== 'development'
      })
    });

    logger.info('API request successful', {
      url: API_URL,
      orderId: transactionItem.id,
      status: response.status
    });

    return { success: true, data: response.data };
  } catch (error) {
    logger.error('API request failed', {
      url: API_URL,
      orderId: transactionItem.id,
      error: error.message,
      stack: NODE_ENV === 'development' ? error.stack : undefined
    });

    return {
      success: false,
      error: error.response?.data || error.message
    };
  }
};

// Routes
app.get("/webhook", (req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString()
  });
});

app.post("/webhook", async (req, res) => {
  logger.info('API request successful', JSON.stringify(req.body))
  console.log(JSON.stringify(req.body))
  try {
    // Validation
    const { error, value } = orderSchema.validate(req.body);
    if (error) {
      logger.warn('Validation failed', { error: error.details });
      return res.status(400).json({
        error: "Invalid request data",
        details: error.details.map(d => d.message)
      });
    }

    // Test mode
    if (value.test === "test") {
      logger.info('Test request received');
      return res.status(200).json({
        status: "test",
        message: "Test data received successfully"
      });
    }

    // Prepare data
    const transactionItem = createTransactionItem(value);

    if (!transactionItem.id) {
      logger.error('Missing order ID');
      return res.status(400).json({
        error: "Invalid order data",
        message: "Missing order ID"
      });
    }

    logger.info('Processing order', { orderId: transactionItem.id });

    // Send to external API
    const { success, data, error: apiError } = await sendToApi(transactionItem);

    if (!success) {
      throw apiError;
    }

    logger.info('Order processed successfully', { orderId: transactionItem.id });

    return res.status(200).json({
      status: "success",
      message: "Order received and saved successfully",
      orderId: transactionItem.id,
      apiResponse: data
    });

  } catch (error) {
    logger.error('Order processing failed', {
      error: error.message,
      stack: NODE_ENV === 'development' ? error.stack : undefined
    });

    return res.status(500).json({
      status: "error",
      error: "Internal server error",
      message: "Error processing order",
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    url: req.originalUrl
  });

  res.status(500).json({
    status: "error",
    message: "Internal server error"
  });
});

// Server initialization
app.listen(PORT, () => {
  logger.info(`Server started in ${NODE_ENV} mode on port ${PORT}`);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { reason: reason.message || reason, promise });
});