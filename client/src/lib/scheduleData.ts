export interface Train {
  id: string;
  departureTime: string;
  arrivalTime: string;
  isExpress: boolean;
  _tripId?: string;
}

export interface Schedule {
  weekday: {
    inbound: Train[];
    outbound: Train[];
  };
  saturday: {
    inbound: Train[];
    outbound: Train[];
  };
  sunday: {
    inbound: Train[];
    outbound: Train[];
  };
}

// Helper to generate ID
const generateId = (prefix: string, index: number) => `${prefix}-${index}`;

export const scheduleData: Schedule = {
  weekday: {
    inbound: [
      { id: '600', departureTime: '04:42', arrivalTime: '05:42', isExpress: false },
      { id: '602', departureTime: '05:12', arrivalTime: '06:12', isExpress: false },
      { id: '604', departureTime: '05:42', arrivalTime: '06:42', isExpress: false },
      { id: '606', departureTime: '05:58', arrivalTime: '06:48', isExpress: true },
      { id: '610', departureTime: '06:05', arrivalTime: '07:02', isExpress: true },
      { id: '612', departureTime: '06:22', arrivalTime: '07:13', isExpress: false },
      { id: '614', departureTime: '06:28', arrivalTime: '07:16', isExpress: true },
      { id: '616', departureTime: '06:41', arrivalTime: '07:25', isExpress: true },
      { id: '620', departureTime: '06:45', arrivalTime: '07:32', isExpress: true },
      { id: '622', departureTime: '07:04', arrivalTime: '07:46', isExpress: false },
      { id: '624', departureTime: '07:07', arrivalTime: '08:02', isExpress: true },
      { id: '626', departureTime: '07:22', arrivalTime: '08:13', isExpress: false },
      { id: '628', departureTime: '07:28', arrivalTime: '08:32', isExpress: true },
      { id: '630', departureTime: '07:52', arrivalTime: '08:46', isExpress: false },
      { id: '632', departureTime: '07:58', arrivalTime: '08:48', isExpress: true },
      { id: '634', departureTime: '08:12', arrivalTime: '09:13', isExpress: false },
      { id: '636', departureTime: '08:46', arrivalTime: '09:29', isExpress: false },
      { id: '638', departureTime: '09:12', arrivalTime: '10:10', isExpress: false },
      { id: '640', departureTime: '10:12', arrivalTime: '11:10', isExpress: false },
      { id: '642', departureTime: '11:12', arrivalTime: '12:10', isExpress: false },
      { id: '644', departureTime: '12:12', arrivalTime: '13:10', isExpress: false },
      { id: '646', departureTime: '12:55', arrivalTime: '14:10', isExpress: false },
      { id: '648', departureTime: '13:12', arrivalTime: '14:10', isExpress: false },
      { id: '650', departureTime: '14:12', arrivalTime: '15:10', isExpress: false },
      { id: '652', departureTime: '15:12', arrivalTime: '16:10', isExpress: false },
      { id: '654', departureTime: '16:12', arrivalTime: '17:10', isExpress: false },
      { id: '656', departureTime: '17:12', arrivalTime: '18:10', isExpress: false },
      { id: '658', departureTime: '18:12', arrivalTime: '19:10', isExpress: false },
      { id: '660', departureTime: '19:12', arrivalTime: '20:10', isExpress: false },
      { id: '662', departureTime: '20:12', arrivalTime: '21:10', isExpress: false },
      { id: '664', departureTime: '21:12', arrivalTime: '22:10', isExpress: false },
      { id: '666', departureTime: '22:12', arrivalTime: '23:10', isExpress: false },
    ],
    outbound: [
      { id: '601', departureTime: '05:35', arrivalTime: '06:29', isExpress: false },
      { id: '603', departureTime: '06:35', arrivalTime: '07:29', isExpress: false },
      { id: '605', departureTime: '07:35', arrivalTime: '08:29', isExpress: false },
      { id: '607', departureTime: '08:35', arrivalTime: '09:29', isExpress: false },
      { id: '609', departureTime: '09:35', arrivalTime: '10:29', isExpress: false },
      { id: '611', departureTime: '10:35', arrivalTime: '11:29', isExpress: false },
      { id: '613', departureTime: '11:35', arrivalTime: '12:29', isExpress: false },
      { id: '615', departureTime: '12:35', arrivalTime: '13:29', isExpress: false },
      { id: '617', departureTime: '13:35', arrivalTime: '14:29', isExpress: false },
      { id: '619', departureTime: '14:35', arrivalTime: '15:29', isExpress: false },
      { id: '621', departureTime: '15:22', arrivalTime: '16:10', isExpress: true },
      { id: '623', departureTime: '15:45', arrivalTime: '16:37', isExpress: true },
      { id: '625', departureTime: '16:15', arrivalTime: '17:05', isExpress: true },
      { id: '627', departureTime: '16:35', arrivalTime: '17:29', isExpress: false },
      { id: '629', departureTime: '16:55', arrivalTime: '17:45', isExpress: true },
      { id: '631', departureTime: '17:15', arrivalTime: '18:05', isExpress: true },
      { id: '633', departureTime: '17:35', arrivalTime: '18:29', isExpress: false },
      { id: '635', departureTime: '17:55', arrivalTime: '18:45', isExpress: true },
      { id: '637', departureTime: '18:20', arrivalTime: '19:10', isExpress: false },
      { id: '639', departureTime: '19:35', arrivalTime: '20:29', isExpress: false },
      { id: '641', departureTime: '20:35', arrivalTime: '21:29', isExpress: false },
      { id: '643', departureTime: '21:35', arrivalTime: '22:29', isExpress: false },
      { id: '645', departureTime: '22:35', arrivalTime: '23:29', isExpress: false },
      { id: '647', departureTime: '23:35', arrivalTime: '00:29', isExpress: false },
    ]
  },
  saturday: {
    inbound: [
      { id: '700', departureTime: '06:40', arrivalTime: '07:37', isExpress: false },
      { id: '702', departureTime: '07:25', arrivalTime: '08:23', isExpress: false },
      { id: '704', departureTime: '08:25', arrivalTime: '09:23', isExpress: false },
      { id: '706', departureTime: '09:25', arrivalTime: '10:23', isExpress: false },
      { id: '708', departureTime: '10:25', arrivalTime: '11:23', isExpress: false },
      { id: '710', departureTime: '11:25', arrivalTime: '12:23', isExpress: false },
      { id: '712', departureTime: '12:25', arrivalTime: '13:23', isExpress: false },
      { id: '714', departureTime: '13:25', arrivalTime: '14:23', isExpress: false },
      { id: '716', departureTime: '14:25', arrivalTime: '15:23', isExpress: false },
      { id: '718', departureTime: '15:25', arrivalTime: '16:23', isExpress: false },
      { id: '720', departureTime: '16:25', arrivalTime: '17:23', isExpress: false },
      { id: '722', departureTime: '17:25', arrivalTime: '18:23', isExpress: false },
      { id: '724', departureTime: '18:25', arrivalTime: '19:23', isExpress: false },
      { id: '726', departureTime: '20:25', arrivalTime: '21:23', isExpress: false },
      { id: '730', departureTime: '22:25', arrivalTime: '23:23', isExpress: false },
    ],
    outbound: [
      { id: '701', departureTime: '08:30', arrivalTime: '09:23', isExpress: false },
      { id: '703', departureTime: '10:30', arrivalTime: '11:23', isExpress: false },
      { id: '705', departureTime: '11:30', arrivalTime: '12:23', isExpress: false },
      { id: '707', departureTime: '12:30', arrivalTime: '13:23', isExpress: false },
      { id: '709', departureTime: '13:30', arrivalTime: '14:23', isExpress: false },
      { id: '711', departureTime: '14:30', arrivalTime: '15:23', isExpress: false },
      { id: '713', departureTime: '15:30', arrivalTime: '16:23', isExpress: false },
      { id: '715', departureTime: '16:30', arrivalTime: '17:23', isExpress: false },
      { id: '717', departureTime: '17:30', arrivalTime: '18:23', isExpress: false },
      { id: '719', departureTime: '18:30', arrivalTime: '19:23', isExpress: false },
      { id: '721', departureTime: '20:30', arrivalTime: '21:23', isExpress: false },
      { id: '723', departureTime: '22:30', arrivalTime: '23:23', isExpress: false },
      { id: '725', departureTime: '00:30', arrivalTime: '01:23', isExpress: false },
    ]
  },
  sunday: {
    inbound: [
      { id: '802', departureTime: '06:40', arrivalTime: '07:37', isExpress: false },
      { id: '804', departureTime: '08:25', arrivalTime: '09:23', isExpress: false },
      { id: '806', departureTime: '10:25', arrivalTime: '11:23', isExpress: false },
      { id: '808', departureTime: '12:25', arrivalTime: '13:23', isExpress: false },
      { id: '810', departureTime: '14:25', arrivalTime: '15:23', isExpress: false },
      { id: '812', departureTime: '16:25', arrivalTime: '17:23', isExpress: false },
      { id: '814', departureTime: '18:25', arrivalTime: '19:23', isExpress: false },
      { id: '816', departureTime: '20:25', arrivalTime: '21:23', isExpress: false },
      { id: '818', departureTime: '22:25', arrivalTime: '23:23', isExpress: false },
    ],
    outbound: [
      { id: '803', departureTime: '08:30', arrivalTime: '09:23', isExpress: false },
      { id: '805', departureTime: '10:30', arrivalTime: '11:23', isExpress: false },
      { id: '807', departureTime: '12:30', arrivalTime: '13:23', isExpress: false },
      { id: '809', departureTime: '14:30', arrivalTime: '15:23', isExpress: false },
      { id: '811', departureTime: '16:30', arrivalTime: '17:23', isExpress: false },
      { id: '813', departureTime: '18:30', arrivalTime: '19:23', isExpress: false },
      { id: '815', departureTime: '20:30', arrivalTime: '21:23', isExpress: false },
      { id: '817', departureTime: '22:30', arrivalTime: '23:23', isExpress: false },
      { id: '819', departureTime: '00:30', arrivalTime: '01:23', isExpress: false },
    ]
  }
};
