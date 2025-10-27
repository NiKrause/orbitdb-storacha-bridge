import pino from "pino";

const defaultConfig = {
  level: process.env.LOG_LEVEL || "info",
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
};

function createLogger(config = {}) {
  const loggerConfig = { ...defaultConfig, ...config };

  if (
    process.env.NODE_ENV === "development" ||
    process.env.LOG_PRETTY === "true"
  ) {
    return pino({
      ...loggerConfig,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      },
    });
  }

  return pino(loggerConfig);
}

export const logger = createLogger();

/**
 * Create a child logger with additional context
 * @param {Object} bindings - Additional context to include in all log messages
 * @returns {Object} Child logger instance
 */
export function createChildLogger(bindings) {
  return logger.child(bindings);
}

export const LOG_LEVELS = {
  TRACE: "trace",
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
  FATAL: "fatal",
};

export const logUtils = {
  /**
   * Log function entry with parameters
   * @param {string} functionName - Name of the function
   * @param {Object} params - Function parameters
   * @param {Object} childLogger - Optional child logger
   */
  functionEntry: (functionName, params = {}, childLogger = logger) => {
    childLogger.debug(
      { function: functionName, params },
      `Entering ${functionName}`,
    );
  },

  /**
   * Log function exit with result
   * @param {string} functionName - Name of the function
   * @param {*} result - Function result
   * @param {Object} childLogger - Optional child logger
   */
  functionExit: (functionName, result, childLogger = logger) => {
    childLogger.debug(
      { function: functionName, result },
      `Exiting ${functionName}`,
    );
  },

  /**
   * Log operation progress
   * @param {string} operation - Operation name
   * @param {number} current - Current progress
   * @param {number} total - Total items
   * @param {Object} childLogger - Optional child logger
   */
  progress: (operation, current, total, childLogger = logger) => {
    const percentage = Math.round((current / total) * 100);
    childLogger.info(
      {
        operation,
        progress: { current, total, percentage },
      },
      `${operation}: ${current}/${total} (${percentage}%)`,
    );
  },

  /**
   * Log timing information
   * @param {string} operation - Operation name
   * @param {number} startTime - Start time (from Date.now())
   * @param {Object} childLogger - Optional child logger
   */
  timing: (operation, startTime, childLogger = logger) => {
    const duration = Date.now() - startTime;
    childLogger.info(
      { operation, duration },
      `${operation} completed in ${duration}ms`,
    );
  },
};

export const loggerConfigs = {
  development: {
    level: "debug",
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
      },
    },
  },

  production: {
    level: "info",
    formatters: {
      level: (label) => ({ level: label }),
    },
  },

  test: {
    level: "error",
  },
};

/**
 * Set logger level at runtime
 * @param {string} level - Log level to set
 */
export function setLogLevel(level) {
  logger.level = level;
}

export function disableLogging() {
  logger.level = "silent";
}

export function enableLogging(level = "info") {
  logger.level = level;
}

export default logger;
