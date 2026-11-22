//! Land cover for open ground (lots), by the terrain triangle it lies in: grass on the plains, forest in the
//! mountains, rock above the treeline or where it's steep, snow on the highest gentle ground. Rules for Colorado's
//! Front Range, until real land cover data (NLCD) replaces them behind this function. Heights are above the
//! ellipsoid (the geoid is about 17 m below it there: close enough for rules this rough).

/// What open ground is, in the order of the ground kinds that follow "lot" (lot itself is grass).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Cover {
    Grass,
    Forest,
    Rock,
    Snow,
}

/// Forest from here up, m.
const FOREST: f64 = 2100.0;
/// No trees above this, m.
const TREELINE: f64 = 3500.0;
/// Snow from here up where it isn't steep, m.
const SNOW: f64 = 3900.0;
/// Bare rock at any height where the ground is steeper than this (the up component of its normal below cos 35°).
const STEEP: f64 = 0.819;
/// Snow doesn't lie where steeper than this (cos 40°).
const SNOW_STEEP: f64 = 0.766;

/// The cover of a terrain triangle at mean height `h` (m) whose unit normal's up component is `up`.
pub fn cover(h: f64, up: f64) -> Cover {
    if h >= SNOW && up >= SNOW_STEEP {
        Cover::Snow
    } else if h >= TREELINE || (h >= FOREST && up < STEEP) {
        Cover::Rock
    } else if h >= FOREST {
        Cover::Forest
    } else {
        Cover::Grass
    }
}
