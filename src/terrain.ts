// =====================================================================
// LANE 1: terrain/height pipeline -- STUB, UNCLAIMED. Owner TBD.
// Replace EllipsoidTerrainProvider with a keyless free source (e.g. AWS
// Terrain Tiles / terrarium decoded into a Cesium terrain provider).
// No Cesium ion, no tokens. Keep the exported signature.
// =====================================================================
import { EllipsoidTerrainProvider, type TerrainProvider } from 'cesium';

export function createTerrainProvider(): TerrainProvider {
  return new EllipsoidTerrainProvider();
}
