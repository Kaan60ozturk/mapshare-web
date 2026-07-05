import { useState, useEffect, useRef } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp, onSnapshot, collection, query, where } from 'firebase/firestore';
import { auth, loginWithGoogle, logout, db, OperationType, handleFirestoreError } from './lib/firebase';
import { MapContainer, TileLayer, Marker, Popup, useMap, ZoomControl } from 'react-leaflet';
import L from 'leaflet';
import { LogOut, MapPin, Shield, Users, Compass, Navigation, Search, Menu, X, ArrowUpRight } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Types ---
interface UserLocation {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string;
  location: { lat: number; lng: number };
  updatedAt: any;
  role: 'admin' | 'user';
  isSharing: boolean;
}

// --- Components ---

function MapController({ center, zoom }: { center: [number, number], zoom: number }) {
  const map = useMap();
  const [hasInitialCentered, setHasInitialCentered] = useState(false);
  
  useEffect(() => {
    // Aggressive size fix for the "tiled/kare" map issue
    const fixSize = () => {
      map.invalidateSize();
    };
    
    fixSize();
    const timers = [
      setTimeout(fixSize, 100),
      setTimeout(fixSize, 500),
      setTimeout(fixSize, 1500),
    ];
    
    window.addEventListener('resize', fixSize);
    return () => {
      timers.forEach(t => clearTimeout(t));
      window.removeEventListener('resize', fixSize);
    };
  }, [map]);

  useEffect(() => {
    if (center[0] !== 0 && !hasInitialCentered) {
      map.setView(center, zoom);
      setHasInitialCentered(true);
    }
  }, [center, map, zoom, hasInitialCentered]);

  return null;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [userData, setUserData] = useState<UserLocation | null>(null);
  const [allUsers, setAllUsers] = useState<UserLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [currentPos, setCurrentPos] = useState<[number, number]>([0, 0]);
  const [mapZoom, setMapZoom] = useState(13);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [isSharing, setIsSharing] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const mapRef = useRef<L.Map | null>(null);

  // Sync isSharing state to Firestore
  const toggleSharing = async () => {
    const newStatus = !isSharing;
    setIsSharing(newStatus);
    
    if (user) {
      const userRef = doc(db, 'users', user.uid);
      try {
        await setDoc(userRef, { 
          isSharing: newStatus,
          updatedAt: serverTimestamp() 
        }, { merge: true });
      } catch (error) {
        console.warn("Sharing status update failed", error);
      }
    }
  };

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        setUser(firebaseUser);
        const isAdminEmail = firebaseUser.email === 'monsternotebook60@gmail.com';
        
        const userRef = doc(db, 'users', firebaseUser.uid);
        try {
          const userSnap = await getDoc(userRef);
          
          if (!userSnap.exists()) {
            const initialData: any = {
              uid: firebaseUser.uid,
              email: firebaseUser.email,
              displayName: firebaseUser.displayName || 'Anonymous',
              photoURL: firebaseUser.photoURL || '',
              location: { lat: 0, lng: 0 },
              updatedAt: serverTimestamp(),
              role: isAdminEmail ? 'admin' : 'user',
              isSharing: true
            };
            await setDoc(userRef, initialData);
            setUserData(initialData);
            setIsSharing(true);
            setShowWelcome(true);
          } else {
            const data = userSnap.data() as UserLocation;
            setUserData(data);
            setIsSharing(data.isSharing ?? true);
            if (isAdminEmail && data.role !== 'admin') {
               await setDoc(userRef, { role: 'admin' }, { merge: true });
            }
          }
          setIsAdmin(isAdminEmail || (userSnap.exists() && userSnap.data()?.role === 'admin'));
        } catch (error) {
          console.warn("User data sync failed:", error);
          setIsAdmin(isAdminEmail);
        }
      } else {
        setUser(null);
        setUserData(null);
        setAllUsers([]);
        setIsAdmin(false);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  // Geolocation Watcher
  useEffect(() => {
    if (!user || !isSharing) return;

    const watchId = navigator.geolocation.watchPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        setCurrentPos([latitude, longitude]);
        
        const userRef = doc(db, 'users', user.uid);
        try {
          await setDoc(userRef, {
            location: { lat: latitude, lng: longitude },
            updatedAt: serverTimestamp()
          }, { merge: true });
        } catch (error) {
          console.warn("Location sync failed", error);
        }
      },
      (error) => console.error(error),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [user, isSharing]);

  // Real-time Listeners
  useEffect(() => {
    if (!user) return;
    
    let unsubscribe: () => void;
    
    // We fetch all users, but we will filter them in the render phase for freshness
    const q = isAdmin 
      ? collection(db, 'users') 
      : query(collection(db, 'users'), where('uid', '==', user.uid));

    unsubscribe = onSnapshot(q, (snapshot) => {
      const users = snapshot.docs.map(doc => doc.data() as UserLocation);
      setAllUsers(users);
    }, (err) => console.error(err));

    return () => unsubscribe && unsubscribe();
  }, [user, isAdmin]);

  // Filter for active users (updated within last 10 minutes and currently sharing)
  const activeUsers = allUsers.filter(u => {
    if (!u.location || u.location.lat === 0) return false;
    if (u.isSharing === false) return false; // Respect explicit stop sharing
    if (!u.updatedAt) return true; // Newly created
    
    const lastUpdate = u.updatedAt.toDate().getTime();
    const tenMinutesAgo = Date.now() - (10 * 60 * 1000);
    return lastUpdate > tenMinutesAgo;
  });

  // Handle overlapping markers by applying a tiny offset
  const getPositionWithOffset = (user: UserLocation, index: number, all: UserLocation[]) => {
    const lat = user.location.lat;
    const lng = user.location.lng;
    
    // Check how many users share this exact location (or very close)
    const overlaps = all.filter((u, i) => 
      i < index && 
      Math.abs(u.location.lat - lat) < 0.0001 && 
      Math.abs(u.location.lng - lng) < 0.0001
    ).length;

    if (overlaps === 0) return [lat, lng] as [number, number];

    // Apply a small spiral offset
    const angle = overlaps * 0.5;
    const radius = 0.0001 * overlaps;
    return [
      lat + radius * Math.cos(angle),
      lng + radius * Math.sin(angle)
    ] as [number, number];
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    const match = activeUsers.find(u => 
      u.displayName.toLowerCase().includes(searchQuery.toLowerCase()) || 
      u.email.toLowerCase().includes(searchQuery.toLowerCase())
    );

    if (match) {
      jumpToLocation(match.location.lat, match.location.lng);
      setSearchQuery('');
    }
  };

  const createCustomIcon = (photoURL: string) => {
    return L.divIcon({
      className: 'custom-marker',
      html: `<div class="avatar-marker"><img src="${photoURL || 'https://www.gravatar.com/avatar/00000000000000000000000000000000?d=mp&f=y'}" referrerPolicy="no-referrer" /></div>`,
      iconSize: [48, 48],
      iconAnchor: [24, 48],
    });
  };

  const jumpToLocation = (lat: number, lng: number) => {
    if (mapRef.current) {
      mapRef.current.setView([lat, lng], 16);
    }
  };

  if (loading) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-slate-50">
        <div className="relative">
          <motion.div 
            animate={{ scale: [1, 1.1, 1], opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 2, repeat: Infinity }}
            className="w-24 h-24 bg-emerald-500/10 rounded-full flex items-center justify-center"
          >
            <MapPin className="w-10 h-10 text-emerald-500" />
          </motion.div>
        </div>
        <p className="mt-4 font-medium text-slate-400 animate-pulse">Initializing map...</p>
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-slate-50 font-sans text-slate-900 overflow-hidden relative select-none">
      <AnimatePresence mode="wait">
        {!user ? (
          <motion.div 
            key="login"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full w-full flex flex-col items-center justify-center p-6 bg-[radial-gradient(circle_at_top_right,_var(--tw-gradient-stops))] from-slate-100 via-white to-emerald-50"
          >
             <div className="max-w-md w-full bg-white/70 backdrop-blur-2xl p-10 rounded-[40px] border border-white shadow-2xl shadow-emerald-500/10 text-center">
                <div className="w-20 h-20 bg-emerald-500 rounded-3xl flex items-center justify-center mx-auto mb-8 shadow-2xl shadow-emerald-500/40 rotate-3">
                  <Navigation className="w-10 h-10 text-white fill-white" />
                </div>
                <h1 className="text-4xl font-bold text-slate-900 mb-3 tracking-tight">MapShare</h1>
                <p className="text-slate-500 mb-10 leading-relaxed max-w-xs mx-auto">
                  Connect with friends and discover who's nearby in real-time.
                </p>
                <button
                  id="google-login"
                  onClick={loginWithGoogle}
                  className="w-full h-16 bg-slate-900 text-white rounded-2xl font-bold flex items-center justify-center gap-4 hover:bg-black transition-all active:scale-95 group shadow-xl"
                >
                  <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/layout/google.svg" className="w-6 h-6 grayscale brightness-200" alt="Google" />
                  Sign in with Google
                  <ArrowUpRight className="w-4 h-4 opacity-50 group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform" />
                </button>
             </div>
          </motion.div>
        ) : (
          <div className="h-full w-full flex flex-col">
            {/* Main Header / Search bar style */}
            <header className="absolute top-6 left-6 right-6 z-[1000] flex items-center gap-4 pointer-events-none">
              <div className="flex-1 max-w-xl pointer-events-auto">
                <form onSubmit={handleSearch} className="bg-white/80 backdrop-blur-xl border border-slate-200/50 h-14 rounded-2xl shadow-2xl shadow-slate-200/50 flex items-center px-4 gap-3">
                   <button 
                     type="button"
                     onClick={() => setIsSidebarOpen(true)}
                     className="p-2 hover:bg-slate-100 rounded-xl transition-colors text-slate-500"
                   >
                     <Menu className="w-5 h-5" />
                   </button>
                   <div className="flex-1 flex items-center gap-2">
                      <Search className="w-4 h-4 text-slate-300" />
                      <input 
                        type="text" 
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder={isAdmin ? "Search users..." : "MapShare Live"}
                        className="bg-transparent border-none outline-none w-full text-sm font-medium placeholder:text-slate-300"
                        readOnly={!isAdmin}
                      />
                   </div>
                   {isAdmin && searchQuery.trim() && (
                      <button type="submit" className="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-1 rounded-md">
                        SEARCH
                      </button>
                   )}
                   <div className="h-8 w-[1px] bg-slate-100 mx-1" />
                   <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full overflow-hidden bg-slate-100 border border-slate-200">
                        <img src={user.photoURL || ''} alt="User" referrerPolicy='no-referrer' />
                      </div>
                   </div>
                </form>
              </div>

              {/* Status Pill */}
              <div className={`transition-colors duration-500 ${isSharing ? 'bg-emerald-500 border-emerald-400' : 'bg-slate-400 border-slate-300'} text-white px-4 h-14 rounded-2xl flex items-center gap-3 shadow-xl pointer-events-auto border`}>
                 <div className={`w-2 h-2 rounded-full bg-white ${isSharing ? 'animate-pulse' : ''}`} />
                 <span className="text-xs font-bold tracking-tight uppercase">
                   {isSharing ? 'Live' : 'Hidden'}
                 </span>
              </div>
            </header>

            {/* Sidebar / User List */}
            <AnimatePresence>
              {isSidebarOpen && (
                <>
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    onClick={() => setIsSidebarOpen(false)}
                    className="absolute inset-0 bg-slate-900/10 backdrop-blur-[2px] z-[2000]"
                  />
                  <motion.div 
                    initial={{ x: -300 }}
                    animate={{ x: 0 }}
                    exit={{ x: -300 }}
                    transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                    className="absolute top-0 left-0 bottom-0 w-80 bg-white shadow-2xl z-[2001] flex flex-col"
                  >
                     <div className="p-8 border-b border-slate-100 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                           <div className="w-10 h-10 bg-emerald-500 rounded-xl flex items-center justify-center">
                             <Navigation className="w-5 h-5 text-white" />
                           </div>
                           <h2 className="font-bold text-xl tracking-tight">MapShare</h2>
                        </div>
                        <button onClick={() => setIsSidebarOpen(false)} className="p-2 hover:bg-slate-100 rounded-lg text-slate-400">
                          <X className="w-5 h-5" />
                        </button>
                     </div>

                     <div className="flex-1 overflow-y-auto py-6 px-4 space-y-6">
                        {isAdmin ? (
                          <div className="space-y-2">
                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-4 mb-4">
                              Nearby Users ({activeUsers.length})
                            </p>
                            {activeUsers.map(u => (
                              <button 
                                key={u.uid}
                                onClick={() => {
                                  jumpToLocation(u.location.lat, u.location.lng);
                                  setIsSidebarOpen(false);
                                }}
                                className="w-full flex items-center gap-3 p-3 hover:bg-slate-50 rounded-2xl transition-all group"
                              >
                                <img src={u.photoURL} className="w-10 h-10 rounded-full border-2 border-slate-100" referrerPolicy="no-referrer" />
                                <div className="flex-1 text-left">
                                  <p className="text-sm font-bold text-slate-900">{u.displayName}</p>
                                  <p className="text-[10px] text-slate-400 tracking-wider">
                                    {u.role === 'admin' ? 'ADMIN' : (u.isSharing ? 'SHARING' : 'STOPPED')}
                                  </p>
                                </div>
                                <ArrowUpRight className="w-4 h-4 text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity" />
                              </button>
                            ))}
                          </div>
                        ) : (
                          <div className="p-4 bg-slate-50 rounded-3xl border border-slate-100 text-center">
                             <Shield className="w-8 h-8 text-emerald-500 mx-auto mb-4" />
                             <h3 className="text-sm font-bold text-slate-900 mb-2">Private Explorer</h3>
                             <p className="text-xs text-slate-400 leading-relaxed">
                               You are currently exploring solo. Only admins can see user clusters for security reasons.
                             </p>
                          </div>
                        )}
                     </div>

                     <div className="p-6 border-t border-slate-100 space-y-3">
                        <div className="flex items-center gap-3 p-3 rounded-2xl bg-slate-50">
                           <img src={user.photoURL || ''} className="w-10 h-10 rounded-full border border-white shadow-sm" referrerPolicy='no-referrer' />
                           <div className="flex-1">
                              <p className="text-xs font-bold text-slate-800 leading-none mb-1">{user.displayName}</p>
                              <p className="text-[10px] text-slate-400 break-all">{user.email}</p>
                           </div>
                        </div>
                        <button 
                          onClick={logout}
                          className="w-full h-12 flex items-center justify-center gap-2 text-red-500 font-bold hover:bg-red-50 rounded-2xl transition-colors"
                        >
                          <LogOut className="w-4 h-4" />
                          Sign Out
                        </button>
                     </div>
                  </motion.div>
                </>
              )}
            </AnimatePresence>

            {/* Floating Zoom/Controls */}
            <div className="absolute right-6 bottom-32 z-[1000] flex flex-col gap-3">
               <button 
                 onClick={() => jumpToLocation(currentPos[0], currentPos[1])}
                 className="w-14 h-14 bg-white rounded-2xl shadow-2xl shadow-slate-900/5 flex items-center justify-center text-slate-600 hover:text-emerald-500 transition-colors border border-slate-200"
               >
                 <Compass className="w-6 h-6" />
               </button>
               <div className="bg-white rounded-2xl shadow-2xl shadow-slate-900/5 flex flex-col border border-slate-200 overflow-hidden">
                  <button 
                    onClick={() => mapRef.current?.zoomIn()}
                    className="w-14 h-14 flex items-center justify-center text-xl font-bold text-slate-400 hover:text-emerald-500 hover:bg-slate-50 border-b border-slate-100"
                  >
                    +
                  </button>
                  <button 
                    onClick={() => mapRef.current?.zoomOut()}
                    className="w-14 h-14 flex items-center justify-center text-xl font-bold text-slate-400 hover:text-emerald-500 hover:bg-slate-50"
                  >
                    -
                  </button>
               </div>
            </div>

            {/* Map */}
            <div className="flex-1 relative z-0">
               <MapContainer 
                 center={[41.0082, 28.9784]} 
                 zoom={13} 
                 scrollWheelZoom={true}
                 zoomControl={false}
                 className="flex-1"
                 ref={(m) => { mapRef.current = m; }}
               >
                 <TileLayer
                   attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
                   url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
                 />
                 
                 {activeUsers.map((u, idx) => (
                   u.location.lat !== 0 && (
                     <Marker 
                       key={u.uid} 
                       position={getPositionWithOffset(u, idx, activeUsers)}
                       icon={createCustomIcon(u.photoURL)}
                       riseOnHover={true}
                     >
                       <Popup>
                         <div className="flex items-center gap-3 p-1 min-w-[200px]">
                           <img src={u.photoURL} className="w-10 h-10 rounded-full shadow-md" referrerPolicy="no-referrer" />
                           <div>
                             <p className="font-bold text-slate-900 text-sm">{u.displayName}</p>
                             <p className="text-[10px] text-slate-400 italic">
                               {u.updatedAt ? `Last active: ${u.updatedAt.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Live'}
                             </p>
                           </div>
                         </div>
                       </Popup>
                     </Marker>
                   )
                 ))}

                 <MapController center={currentPos} zoom={mapZoom} />
               </MapContainer>
            </div>
            
            {/* Bottom Floating Card / User Stats */}
            <footer className="absolute bottom-6 left-6 right-6 z-[1000] pointer-events-none">
               <div className="flex justify-between items-end">
                  <div className="bg-white/90 backdrop-blur-xl p-3 rounded-[28px] border border-white shadow-2xl pointer-events-auto max-w-sm flex items-center gap-4">
                     <div className={`w-10 h-10 transition-colors duration-300 ${isSharing ? 'bg-slate-900' : 'bg-slate-200'} rounded-2xl flex items-center justify-center flex-shrink-0`}>
                        <Users className={`w-5 h-5 ${isSharing ? 'text-white' : 'text-slate-400'}`} />
                     </div>
                     <div className="flex-1 pr-2">
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Connection</p>
                        <p className="text-xs font-bold text-slate-900">
                          {isAdmin ? `${activeUsers.length} users online` : (isSharing ? 'Sharing Active' : 'Sharing Paused')}
                        </p>
                     </div>
                     <div className="h-8 w-[1px] bg-slate-100 mx-1" />
                     <button
                       onClick={toggleSharing}
                       className={`px-4 py-2 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all ${
                         isSharing 
                          ? 'bg-red-50 text-red-500 hover:bg-red-100' 
                          : 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/20'
                       }`}
                     >
                       {isSharing ? 'Stop' : 'Start'}
                     </button>
                  </div>
               </div>
            </footer>

            {/* Welcome Toasty */}
            <AnimatePresence>
               {showWelcome && (
                 <motion.div 
                   initial={{ opacity: 0, scale: 0.9, y: 50 }}
                   animate={{ opacity: 1, scale: 1, y: 0 }}
                   exit={{ opacity: 0, scale: 0.9, y: 50 }}
                   className="absolute inset-0 z-[5000] flex items-center justify-center pointer-events-none p-6"
                 >
                    <div className="bg-slate-900 text-white p-8 rounded-[40px] shadow-3xl pointer-events-auto text-center max-w-sm border border-slate-800">
                       <div className="w-16 h-16 bg-emerald-500 rounded-full flex items-center justify-center mx-auto mb-6 shadow-xl shadow-emerald-500/30">
                          <MapPin className="w-8 h-8 text-white" />
                       </div>
                       <h2 className="text-2xl font-bold mb-2">Welcome to MapShare!</h2>
                       <p className="text-slate-400 text-sm mb-8 leading-relaxed">
                          Your profile has been created. Start sharing your location and explore the map.
                       </p>
                       <button 
                         onClick={() => setShowWelcome(false)}
                         className="w-full py-4 bg-emerald-500 text-white font-bold rounded-2xl shadow-xl shadow-emerald-500/20 active:scale-95 transition-all"
                       >
                         Let's Go
                       </button>
                    </div>
                 </motion.div>
               )}
            </AnimatePresence>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
