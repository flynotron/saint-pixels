import { PlacePixel } from "../actions/PlacePixel";

export function initializeActions(app) {
  app.post('api/pixel', PlacePixel.execute);
}