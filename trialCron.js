import cron from 'node-cron';
import { db, trialStatus } from './db.js';

export function startTrialCron() {
  // Runs once a day at 08:00 server time.
  cron.schedule('0 8 * * *', () => {
    const status = trialStatus();
    if (!status) return;

    if (status.status === 'trial' && status.daysLeft <= 5 && status.daysLeft > 0) {
      db.prepare("INSERT INTO alerts (type, message) VALUES ('trial_ending', ?)")
        .run(`Trial ends in ${status.daysLeft} day(s) — add billing details to avoid interruption.`);
    }
    if (status.expired) {
      db.prepare("UPDATE business SET subscription_status = 'past_due' WHERE id = 1 AND subscription_status = 'trial'").run();
      db.prepare("INSERT INTO alerts (type, message) VALUES ('trial_ended', 'Free trial has ended. WhatsApp assistant is paused until billing is set up.')").run();
    }
  });
}
