package com.example.events;

import lombok.Data;
import lombok.Getter;
import lombok.Setter;

@Data
@Setter
@Getter
public class Event {
	private String id;
	private String eventType;
	private String eventId;
	private int createdAt;
	private String body;
}
