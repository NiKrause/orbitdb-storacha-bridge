import { retryWithBackoff, withRetry } from '../lib/retry.js';

console.log('🔄 Retry Mechanism Demo\n');
console.log('='.repeat(60));

console.log('\n📝 Demo 1: Basic Retry with Simulated Failures\n');

let attemptCount = 0;
const unreliableOperation = async () => {
  attemptCount++;
  console.log(`   Attempt ${attemptCount}...`);
  
  if (attemptCount < 3) {
    throw new Error('ETIMEDOUT: Connection timeout');
  }
  
  return 'Success!';
};

try {
  const result = await retryWithBackoff(unreliableOperation, {
    operationName: 'Unreliable Network Call',
    maxRetries: 3,
    initialDelayMs: 500,
    onRetry: (error, attempt, delay) => {
      console.log(`   ⚠️  Retry ${attempt + 1} scheduled in ${delay}ms`);
    }
  });
  
  console.log(`   ✅ Final result: ${result}`);
} catch (error) {
  console.error(`   ❌ Operation failed: ${error.message}`);
}

console.log('\n📝 Demo 2: Non-Retryable Error (Fails Immediately)\n');

attemptCount = 0;
const invalidOperation = async () => {
  attemptCount++;
  console.log(`   Attempt ${attemptCount}...`);
  throw new Error('Invalid authentication credentials');
};

try {
  await retryWithBackoff(invalidOperation, {
    operationName: 'Invalid Auth Operation',
    maxRetries: 3,
    initialDelayMs: 500,
  });
} catch (error) {
  console.log(`   ✅ Correctly failed without retry: ${error.message}`);
}

console.log('\n📝 Demo 3: Wrapped Function with Retry\n');

attemptCount = 0;
const fetchData = async (url) => {
  attemptCount++;
  console.log(`   Fetching ${url} (attempt ${attemptCount})...`);
  
  if (attemptCount < 2) {
    throw new Error('503: Service Unavailable');
  }
  
  return { data: 'mock data', url };
};

const fetchDataWithRetry = withRetry(fetchData, {
  operationName: 'Fetch Data',
  maxRetries: 3,
  initialDelayMs: 300,
});

try {
  const result = await fetchDataWithRetry('https://example.com/api/data');
  console.log(`   ✅ Success:`, result);
} catch (error) {
  console.error(`   ❌ Failed: ${error.message}`);
}

console.log('\n📝 Demo 4: Custom Retry Configuration\n');

attemptCount = 0;
const customOperation = async () => {
  attemptCount++;
  console.log(`   Attempt ${attemptCount}...`);
  
  if (attemptCount < 4) {
    throw new Error('429: Too Many Requests');
  }
  
  return 'Success after rate limit!';
};

try {
  const result = await retryWithBackoff(customOperation, {
    operationName: 'Rate Limited API',
    maxRetries: 5,
    initialDelayMs: 1000,
    maxDelayMs: 10000,
    backoffMultiplier: 3,
    jitterMs: 200,
    onRetry: (error, attempt, delay) => {
      console.log(`   ⏳ Rate limited. Waiting ${delay}ms before retry ${attempt + 1}...`);
    }
  });
  
  console.log(`   ✅ ${result}`);
} catch (error) {
  console.error(`   ❌ Failed: ${error.message}`);
}

console.log('\n📝 Demo 5: Simulated Upload with Retry\n');

const simulateUpload = async (filename, data) => {
  const random = Math.random();
  
  if (random < 0.3) {
    throw new Error('ECONNRESET: Connection reset by peer');
  } else if (random < 0.5) {
    throw new Error('ETIMEDOUT: Request timeout');
  }
  
  return {
    filename,
    cid: `bafkrei${Math.random().toString(36).substring(7)}`,
    size: data.length,
  };
};

const files = ['block1.dat', 'block2.dat', 'block3.dat'];

console.log(`   Uploading ${files.length} files with retry...\n`);

for (const filename of files) {
  try {
    const result = await retryWithBackoff(
      () => simulateUpload(filename, Buffer.from('mock data')),
      {
        operationName: `Upload ${filename}`,
        maxRetries: 3,
        initialDelayMs: 500,
        onRetry: (error, attempt) => {
          console.log(`   ⚠️  ${filename}: Retry ${attempt + 1} - ${error.message}`);
        }
      }
    );
    
    console.log(`   ✅ ${filename}: Uploaded to ${result.cid}`);
  } catch (error) {
    console.error(`   ❌ ${filename}: Failed - ${error.message}`);
  }
}

console.log('\n' + '='.repeat(60));
console.log('✅ Demo completed!\n');
console.log('Key Takeaways:');
console.log('  • Transient errors (network, timeouts, rate limits) are automatically retried');
console.log('  • Non-retryable errors (auth, validation) fail immediately');
console.log('  • Exponential backoff prevents overwhelming services');
console.log('  • Jitter prevents thundering herd problems');
console.log('  • Progress callbacks enable UI feedback during retries');
