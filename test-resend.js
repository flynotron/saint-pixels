import { Resend } from 'resend';

const resend = new Resend('re_SvqXti1p_9eKBXouZfsMvbNTfek97ofWe');

resend.emails.send({
  from: 'onboarding@resend.dev',
  to: 'jabrelblondine09182008@outlook.com',
  subject: 'Hello World',
  html: '<p>Congrats on sending your <strong>first email</strong>!</p>'
});