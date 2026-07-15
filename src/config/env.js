import dotenv from 'dotenv';

dotenv.config();

function required(name, value) {
  if (!value) {
    // Fail loudly in production; fall back to a dev default otherwise.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`Missing required environment variable: ${name}`);
    }
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: parseInt(process.env.PORT || '4000', 10),
  appUrl: (process.env.APP_URL || 'http://localhost:4000').replace(/\/$/, ''),
  webUrl: (process.env.WEB_URL || 'http://localhost:5173').replace(/\/$/, ''),
  corsOrigin: (process.env.CORS_ORIGIN || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  jwtSecret: required('JWT_SECRET', process.env.JWT_SECRET) || 'dev-insecure-secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30d',
  otpReturnInResponse: (process.env.OTP_RETURN_IN_RESPONSE || 'true') === 'true',

  // Email (Resend)
  resendApiKey: process.env.RESEND_API_KEY || '',
  emailFrom: process.env.EMAIL_FROM || 'BRG Prime <onboarding@resend.dev>',

  // Payments (Paystack)
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY || '',
  paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY || '',
  paystackCallbackUrl: process.env.PAYSTACK_CALLBACK_URL || 'http://localhost:5173/subscriptions',

  // Uploads (Cloudflare R2)
  r2: {
    accountId: process.env.R2_ACCOUNT_ID || '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    bucket: process.env.R2_BUCKET || 'brg-prime',
    publicUrl: (process.env.R2_PUBLIC_URL || '').replace(/\/$/, ''),
  },
};

// Feature availability flags (used to give clear errors when a key is missing).
export const features = {
  email: !!env.resendApiKey,
  paystack: !!env.paystackSecretKey,
  uploads: !!(env.r2.accountId && env.r2.accessKeyId && env.r2.secretAccessKey && env.r2.publicUrl),
};
