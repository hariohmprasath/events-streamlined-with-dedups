package com.example.events;

import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.RequestHandler;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.lang3.StringUtils;
import redis.clients.jedis.Jedis;

import java.net.URLDecoder;
import java.util.Properties;

public class AwsLambdaSqsFunctionHandler implements RequestHandler<Object, Object> {

    private static final Jedis JEDIS = new Jedis(System.getenv("REDIS_ENDPOINT"),
            Integer.parseInt(System.getenv("REDIS_PORT")));
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();
    private static final Properties DEDUP_PROPERTIES = loadProperties();
    public static final String DE_DUP_PROPERTIES = "de-dup.properties";
    public static final String BODY = "body";

    @Override
    public Object handleRequest(Object s, Context context) {
        try {
            final String objStr = OBJECT_MAPPER.writeValueAsString(s);    
            final JsonNode rootNode = OBJECT_MAPPER.readTree(objStr);
            if(rootNode.isArray()) {            
                for (final JsonNode objNode : rootNode) {
                    String message = objNode.get(BODY).asText();            
                    message = URLDecoder.decode(message, "UTF-8");                        
                    final Event event = OBJECT_MAPPER.readValue(message, Event.class);
                    final String eventType = event.getEventType();
        
                    if (!StringUtils.isEmpty(eventType)) {
                        final Object deDupProperty = DEDUP_PROPERTIES.get(event.getEventType());                
                        if (deDupProperty != null) {
                            final int deDupTime = Integer.parseInt(deDupProperty.toString());
                            final String redisKey = event.getEventId();
                            if (JEDIS.get(redisKey) == null) {
                                System.out.println("Inserting event in redis cache: " + message);
                                JEDIS.set(redisKey, message);
                                JEDIS.expire(redisKey, deDupTime);
                            } else
                                System.out.println("Event already exists in redis cache: " + message);                            
                        }
                    }
                }
            }            
        } catch (Exception e) {
            System.out.println("Error while processing event: " + e.getMessage());
            e.printStackTrace();
            return "Error while processing event: " + e.getMessage();
        }
        return "Successfully proceeded";
    }

    private static Properties loadProperties() {
        Properties properties = new Properties();
        try {
            properties.load(AwsLambdaSqsFunctionHandler.class.getClassLoader().getResourceAsStream(DE_DUP_PROPERTIES));            
        } catch (Exception e) {            
            System.out.println("Error while loading properties file: " + e.getMessage());
            e.printStackTrace();
        }
        return properties;
    }
}
