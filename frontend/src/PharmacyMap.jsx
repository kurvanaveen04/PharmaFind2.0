
import React, { useEffect, useMemo, useState } from 'react';
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  CircleMarker,
  useMap
} from 'react-leaflet';
import L from 'leaflet';

const DEFAULT_CENTER = [17.4375, 78.4483];

function RecenterMap({ position }) {
  const map = useMap();

  useEffect(() => {
    if (position) {
      map.setView(position, 14);
    }
  }, [position, map]);

  return null;
}
function FocusPharmacy({ pharmacy }) {
  const map = useMap();

  useEffect(() => {
    if (pharmacy) {
      map.flyTo(
        [Number(pharmacy.latitude), Number(pharmacy.longitude)],
        16,
        { duration: 1.2 }
      );
    }
  }, [pharmacy, map]);

  return null;
}
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default function PharmacyMap({ pharmacies = [] }) {
  const [userPosition, setUserPosition] = useState(null);
  const [selectedPharmacy, setSelectedPharmacy] = useState(null);
  const [locationError, setLocationError] = useState('');

  const validPharmacies = useMemo(() => {
    return pharmacies.filter(p => {
      const lat = Number(p.latitude);
      const lng = Number(p.longitude);

      return Number.isFinite(lat) && Number.isFinite(lng) &&
        p.latitude != null && p.longitude != null &&
        Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    });
  }, [pharmacies]);

  const locateMe = () => {
    if (!navigator.geolocation) {
      setLocationError('Location is not supported by this browser.');
      return;
    }

    navigator.geolocation.getCurrentPosition(
      position => {
        setUserPosition([
          position.coords.latitude,
          position.coords.longitude
        ]);
        setLocationError('');
      },
      () => setLocationError(
        'Location permission was denied. You can still browse the map.'
      ),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const sortedPharmacies = useMemo(() => {
    return [...validPharmacies].map(p => ({
      ...p,
      distance: userPosition
        ? getDistance(
            userPosition[0],
            userPosition[1],
            Number(p.latitude),
            Number(p.longitude)
          )
        : null
    })).sort((a, b) => {
      if (a.distance == null) return 0;
      if (b.distance == null) return 0;
      return a.distance - b.distance;
    });
  }, [validPharmacies, userPosition]);

  return (
    <section className="pharmacy-map-section">
      <div className="map-heading">
        <div>
          <h2>Nearby pharmacies</h2>
          <p>Find pharmacies and view their locations.</p>
        </div>

        <button className="btn btn-primary" onClick={locateMe}>
          Find my location
        </button>
      </div>

      {locationError && (
        <p role="status">{locationError}</p>
      )}

      <div style={{
        height: '430px',
        width: '100%',
        borderRadius: '16px',
        overflow: 'hidden'
      }}>
        <MapContainer
          center={DEFAULT_CENTER}
          zoom={12}
          scrollWheelZoom={true}
          style={{ height: '100%', width: '100%' }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          <RecenterMap position={userPosition} />
<FocusPharmacy pharmacy={selectedPharmacy} />
          {userPosition && (
            <CircleMarker
              center={userPosition}
              radius={9}
              pathOptions={{
                color: '#ffffff',
                fillColor: '#087f69',
                fillOpacity: 1,
                weight: 3
              }}
            >
              <Popup>Your current location</Popup>
            </CircleMarker>
          )}

          {validPharmacies.map(p => (
            <Marker
              key={p.id}
              position={[Number(p.latitude), Number(p.longitude)]}
            >
              <Popup>
                <strong>{p.name}</strong>
                <br />
                {p.address}, {p.city}
                <br />
                {p.phone || 'Phone unavailable'}
                <br />
                {p.verified ? 'Verified pharmacy' : 'Verification pending'}
                <br />
                <a
                  href={`https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${userPosition ? `${userPosition[0]}%2C${userPosition[1]}` : `${DEFAULT_CENTER[0]}%2C${DEFAULT_CENTER[1]}`}%3B${p.latitude}%2C${p.longitude}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Get directions
                </a>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>

      <div className="map-results">
        <h3>Pharmacy locations ({validPharmacies.length})</h3>

        {sortedPharmacies.length === 0 ? (
          <p>
            No pharmacies have map coordinates yet.
            Pharmacy locations will appear here once coordinates are added.
          </p>
        ) : (
          sortedPharmacies.map(p => (
            <button
  key={p.id}
  type="button"
  onClick={() => setSelectedPharmacy(p)}
  className="inventory-row"
  style={{
    width: '100%',
    textAlign: 'left',
    cursor: 'pointer',
    border: selectedPharmacy?.id === p.id
      ? '2px solid #087f69'
      : undefined
  }}
>
  <div>
    <strong>{p.name}</strong>
    <small>{p.address}, {p.city}</small>
    {p.distance != null && (
      <small>{p.distance.toFixed(1)} km away</small>
    )}
  </div>
</button>
          ))
        )}
      </div>

      <small>
        Map data © OpenStreetMap contributors.
      </small>
    </section>
  );
}
