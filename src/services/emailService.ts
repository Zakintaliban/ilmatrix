import { Resend } from 'resend';
import { config } from '../config/env.js';

// Initialize Resend
const resend = config.resendApiKey ? new Resend(config.resendApiKey) : null;

export interface EmailVerificationData {
  email: string;
  name: string;
  token: string;
}

export interface WelcomeEmailData {
  email: string;
  name: string;
}

/**
 * Send email verification email
 */
export async function sendVerificationEmail(data: EmailVerificationData): Promise<boolean> {
  if (!resend || !config.emailFromAddress) {
    console.warn('Email verification disabled: Missing RESEND_API_KEY or EMAIL_FROM_ADDRESS');
    return false;
  }

  const verificationUrl = `${config.baseUrl}/verify-email?token=${data.token}`;
  
  const emailData = {
    from: `ILMATRIX <${config.emailFromAddress}>`,
    to: [data.email],
    subject: 'Verify Your ILMATRIX Account',
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #0f0e85 0%, #e44c99 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
            .content { background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
            .button { display: inline-block; background: #0f0e85; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; }
            .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Welcome to ILMATRIX!</h1>
              <p>Your AI Study Companion</p>
            </div>
            <div class="content">
              <h2>Hi ${data.name}!</h2>
              <p>Thank you for joining ILMATRIX. To complete your registration, please verify your email address by clicking the button below:</p>
              
              <p style="text-align: center; margin: 30px 0;">
                <a href="${verificationUrl}" class="button">Verify Email Address</a>
              </p>
              
              <p>Or copy and paste this link into your browser:</p>
              <p style="word-break: break-all; background: #e5e7eb; padding: 10px; border-radius: 4px; font-family: monospace;">
                ${verificationUrl}
              </p>
              
              <p><strong>This link will expire in 24 hours.</strong></p>
              
              <p>If you didn't create an account with ILMATRIX, please ignore this email.</p>
              
              <p>Happy studying!<br>The ILMATRIX Team</p>
            </div>
            <div class="footer">
              <p>© 2025 ILMATRIX. All rights reserved.</p>
            </div>
          </div>
        </body>
      </html>
    `,
    text: `
      Welcome to ILMATRIX!
      
      Hi ${data.name}!
      
      Thank you for joining ILMATRIX. To complete your registration, please verify your email address by visiting this link:
      
      ${verificationUrl}
      
      This link will expire in 24 hours.
      
      If you didn't create an account with ILMATRIX, please ignore this email.
      
      Happy studying!
      The ILMATRIX Team
    `
  };

  try {
    await resend.emails.send(emailData);
    console.log(`Verification email sent to ${data.email}`);
    return true;
  } catch (error) {
    console.error('Failed to send verification email:', error);
    return false;
  }
}

/**
 * Send welcome email after verification
 */
export async function sendWelcomeEmail(data: WelcomeEmailData): Promise<boolean> {
  if (!resend || !config.emailFromAddress) {
    return false;
  }

  const emailData = {
    from: `ILMATRIX <${config.emailFromAddress}>`,
    to: [data.email],
    subject: 'Welcome to ILMATRIX - Your Account is Ready!',
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #0f0e85 0%, #e44c99 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
            .content { background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
            .feature { margin: 20px 0; padding: 15px; background: white; border-radius: 6px; border-left: 4px solid #0f0e85; }
            .button { display: inline-block; background: #0f0e85; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; }
            .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🎉 Account Verified!</h1>
              <p>Welcome to ILMATRIX</p>
            </div>
            <div class="content">
              <h2>Hi ${data.name}!</h2>
              <p>Your email has been verified successfully! Your ILMATRIX account is now ready to use.</p>
              
              <h3>What you can do now:</h3>
              
              <div class="feature">
                <h4>📚 Explain Materials</h4>
                <p>Upload PDFs, DOCX, PPTX, or images and get AI-powered explanations with citations.</p>
              </div>
              
              <div class="feature">
                <h4>📝 Generate MCQ Quizzes</h4>
                <p>Create multiple-choice questions with deterministic grading from your materials.</p>
              </div>
              
              <div class="feature">
                <h4>🃏 Create Flashcards</h4>
                <p>Generate interactive flashcards for better memorization and review.</p>
              </div>
              
              <div class="feature">
                <h4>💬 Chat with Context</h4>
                <p>Have conversations about your study materials with AI assistance.</p>
              </div>
              
              <p style="text-align: center; margin: 30px 0;">
                <a href="${config.baseUrl}/app.html" class="button">Start Studying Now</a>
              </p>
              
              <p>Need help getting started? Check out our <a href="${config.baseUrl}/about.html">about page</a> for tips and tutorials.</p>
              
              <p>Happy studying!<br>The ILMATRIX Team</p>
            </div>
            <div class="footer">
              <p>© 2025 ILMATRIX. All rights reserved.</p>
            </div>
          </div>
        </body>
      </html>
    `
  };

  try {
    await resend.emails.send(emailData);
    console.log(`Welcome email sent to ${data.email}`);
    return true;
  } catch (error) {
    console.error('Failed to send welcome email:', error);
    return false;
  }
}

/**
 * Check if email service is configured
 */
export function isEmailServiceConfigured(): boolean {
  return !!(config.resendApiKey && config.emailFromAddress);
}