import { Router } from 'express';
import { getTripWithStops, updateStopStatus } from './logistics.js';

export const driverRouter = Router();

driverRouter.get('/:token', (req, res) => {
  const data = getTripWithStops(req.params.token, true);
  if (!data) return res.status(404).json({ error: 'Trip link not found or expired.' });
  res.json(data);
});

driverRouter.post('/:token/stops/:stopId', async (req, res) => {
  const data = getTripWithStops(req.params.token, true);
  if (!data) return res.status(404).json({ error: 'Trip link not found or expired.' });

  const stop = data.stops.find((s) => String(s.id) === req.params.stopId);
  if (!stop) return res.status(404).json({ error: 'Stop not found on this trip.' });

  try {
    const { action, delay_minutes, reason } = req.body;
    await updateStopStatus({ stopId: stop.id, action, delayMinutes: delay_minutes, reason });
    res.json(getTripWithStops(req.params.token, true));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
